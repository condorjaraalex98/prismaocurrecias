require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const multer = require("multer");
const bodyParser = require("body-parser");
const cloudinary = require("cloudinary").v2; // Línea 4
const sharp = require("sharp");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
// Obtiene la fecha y hora actual exacta en Perú (Lima) formateada para MySQL

// ⚡ Límite de concurrencia de Sharp para liberar Event Loop de Node.js en cargas masivas
sharp.concurrency(1);

const app = express();

// ==========================================
// POOL MYSQL (REQUERIDO PARA 'db')
// ==========================================
const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 8889,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root",
  database: process.env.DB_NAME || "restaurado",
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: "-05:00", // Forzado a UTC-5 para que independientemente de dónde esté el servidor registre la hora correcta
});

app.use(express.json({ limit: "25mb" }));
app.use("/uploads", express.static("uploads", { maxAge: "1d" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));

// Middlewares
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));

// 📸 Configuración de Multer para recibir fotos individuales en RAM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Límite de 10MB
});

// Configuración de Cloudflare R2 / S3 Client
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN;

// ==========================================
// 📸 ENDPOINT NUEVO: SUBIR FOTO ADJUNTA INDIVIDUAL
// ==========================================
app.post("/ocurrencias/subir-foto-adjunta", upload.single("foto"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No se envió ninguna foto." });
    }

    // 1. Optimización rápida con Sharp + Autorotación EXIF para celulares
    const bufferOptimizado = await sharp(req.file.buffer)
      .rotate() // Corrige la orientación de fotos tomadas verticalmente desde smartphones
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    // 2. Definición del nombre único con hash aleatorio anti-colisión
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(4).toString("hex");
    const fechaActual = new Date();
    const anio = fechaActual.getFullYear();
    const mes = String(fechaActual.getMonth() + 1).padStart(2, "0");
    const nombreArchivo = `ocurrencias/${anio}/${mes}/foto_${timestamp}_${randomId}.jpg`;

    // 3. Subida directa a Cloudflare R2
    await r2Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: nombreArchivo,
        Body: bufferOptimizado,
        ContentType: "image/jpeg",
      })
    );

    const urlImagen = `${PUBLIC_DOMAIN}/${nombreArchivo}`;

    // 4. Retorno de la URL pública de la imagen subida
    return res.json({
      success: true,
      url_imagen: urlImagen,
      public_id: nombreArchivo,
    });
  } catch (error) {
    console.error("🔴 Error al subir foto adjunta:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// FUNCIÓN EN SEGUNDO PLANO (Sharp + R2)
// ==========================================
async function procesarYSubirFotosSegundoPlano(id_ocurrencia, fotos, dbPool) {
  console.log(`\n==================================================`);
  console.log(`⏳ INICIANDO PROCESO EN SEGUNDO PLANO`);
  console.log(`📌 Ocurrencia ID: #${id_ocurrencia}`);
  console.log(`📸 Cantidad de fotos recibidas: ${fotos ? fotos.length : 0}`);
  console.log(`==================================================`);

  if (!fotos || !Array.isArray(fotos) || fotos.length === 0) {
    console.warn(
      `⚠️ No se recibieron fotos en el array para la ocurrencia #${id_ocurrencia}`,
    );
    return;
  }

  for (let [idx, f] of fotos.entries()) {
    try {
      console.log(`\n🔍 Procesando foto index [${idx}]...`);

      let bufferOriginal = null;

      // CASO 1: Viene un archivo real adjunto (desde la web con FormData o buffer directo)
      if (f && f.archivo_real) {
        console.log(`📦 Detectado archivo real físico en foto [${idx}]`);
        if (typeof f.archivo_real.arrayBuffer === "function") {
          const arrayBuffer = await f.archivo_real.arrayBuffer();
          bufferOriginal = Buffer.from(arrayBuffer);
        } else if (Buffer.isBuffer(f.archivo_real)) {
          bufferOriginal = f.archivo_real;
        }
      }
      // CASO 2: Viene como un string o un objeto con propiedades de texto (Base64 o URL)
      else {
        let base64Data = null;
        if (typeof f === "string") {
          base64Data = f;
        } else if (f && f.base64_data) {
          base64Data = f.base64_data;
        } else if (f && f.uri) {
          base64Data = f.uri;
        } else if (f && f.url_imagen) {
          base64Data = f.url_imagen;
        }

        if (!base64Data) {
          console.error(
            `❌ La foto [${idx}] no contiene una estructura válida.`,
            JSON.stringify(f),
          );
          continue;
        }

        // Si es una URL http existente que ya está en la nube (ej. subida con /subir-foto-adjunta), la registra directo en BD
        if (base64Data.startsWith("http")) {
          console.log(
            `🌐 La foto [${idx}] ya es una URL web existente, registrando en BD...`,
          );
          const publicIdExistente = base64Data.includes(PUBLIC_DOMAIN)
            ? base64Data.replace(`${PUBLIC_DOMAIN}/`, "")
            : null;
          await dbPool.query(
            "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES (?, ?, ?)",
            [id_ocurrencia, base64Data, publicIdExistente],
          );
          continue;
        }

        // Limpiar y convertir Base64 a Buffer
        const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
        bufferOriginal = Buffer.from(base64Clean, "base64");
      }

      if (!bufferOriginal) {
        console.error(`❌ No se pudo obtener el buffer de la foto [${idx}]`);
        continue;
      }

      // 3. OPTIMIZAR CON SHARP Y AUTOROTACIÓN
      console.log(`⚙️ Comprimiendo foto [${idx}] con Sharp...`);
      const bufferOptimizado = await sharp(bufferOriginal)
        .rotate() // Corrige rotación vertical/horizontal de smartphone
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();

      const timestamp = Date.now();
      const randomId = crypto.randomBytes(4).toString("hex");
      const fechaActual = new Date();
      const anio = fechaActual.getFullYear();
      const mes = String(fechaActual.getMonth() + 1).padStart(2, "0");

      const nombreArchivo = `ocurrencias/${anio}/${mes}/${id_ocurrencia}_${idx}_${timestamp}_${randomId}.jpg`;

      // 4. SUBIR A CLOUDFLARE R2
      console.log(
        `🚀 Subiendo foto [${idx}] a Cloudflare R2 (${nombreArchivo})...`,
      );
      await r2Client.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: nombreArchivo,
          Body: bufferOptimizado,
          ContentType: "image/jpeg",
        }),
      );

      const urlImagen = `${PUBLIC_DOMAIN}/${nombreArchivo}`;
      console.log(`🌐 URL Generada: ${urlImagen}`);

      // 5. GUARDAR URL Y EL PUBLIC_ID EN MYSQL
      console.log(`💾 Guardando URL y public_id en base de datos MySQL...`);
      await dbPool.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES (?, ?, ?)",
        [id_ocurrencia, urlImagen, nombreArchivo],
      );

      console.log(`✅ ¡FOTO [${idx + 1}] GUARDADA EXITOSAMENTE EN R2 Y MYSQL!`);
    } catch (err) {
      console.error(`🔴 ERROR CRÍTICO EN FOTO [${idx + 1}]:`, err.message);
    }
  }
}

// ==========================================
// 📝 ENDPOINT DE REGISTRO DE OCURRENCIA
// ==========================================
app.post("/ocurrencias/registrar/modr2x", async (req, res) => {
  let connection;
  try {
    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      turno,
      fotos,
      estadoOcurrencia,
      vehiculos_detalle,
      id_personal_ids,
      detalle_llamada,
      agresores_detalle,
      victimas_detalle,
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo,turno
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      estadoOcurrencia, 
      grupo,
      turno || null,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
      }
    }

    // 3. INSERTAR PERSONAL DE APOYO
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsPersLimpios.length > 0) {
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
      }
    }

    // 4. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    // 5. INSERTAR DETALLE DE LLAMADA
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Sin dato",
        ],
      );
    }

    // 6. INSERTAR AGRESORES
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
    }

    // 7. INSERTAR VÍCTIMAS
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
    }

    await connection.commit();

    // 🚀 RESPUESTA INMEDIATA AL USUARIO
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });

    // =========================================================
    // PROCESAR Y SUBIR FOTOS EN SEGUNDO PLANO
    // =========================================================
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(
        (err) => {
          console.error(
            "🔴 Error crítico general en segundo plano de fotos:",
            err.message,
          );
        },
      );
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    if (!res.headersSent) {
      res.status(400).json({ success: false, error: error.message });
    }
  } finally {
    if (connection) connection.release();
  }
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================

app.post("/ocurrencias/registrar/modr2", async (req, res) => {
  let connection;
  try {
    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      turno,
      fotos,
      estadoOcurrencia,
      vehiculos_detalle,
      id_personal_ids,
      detalle_llamada,
      agresores_detalle,
      victimas_detalle,
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();
const fechaReportePeru = new Date().toLocaleString("sv-SE", { timeZone: "America/Lima" });
  
   // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_modalidad_inicial, 
            id_origen, id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo, turno
        ) VALUES (?, ?, ?, ?, ?, ? ,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,                     // 1
      hora_alerta || null,             // 2
      hora_llegada || null,            // 3
      hora_repliegue || null,          // 4
      id_lugar,                        // 5
      id_usuario,                      // 6
      id_modalidad,                    // 7 (id_modalidad principal)
      id_modalidad,                    // 8 (id_modalidad_inicial)
   
      id_origen,                       // 10
      id_tipop || null,                // 11
      id_modalidadp || null,           // 12
      latitud_gps || 0,                // 13
      longitud_gps || 0,               // 14
      nombre_punto_gps || "",          // 15
      referencia || "",                // 16
      unidad_encargada || "SERENAZGO",
      fechaReportePeru,// 17
      fecha_evento,                    // 18
      estadoOcurrencia,                // 19
      grupo,                           // 20
      turno || null                    // 21
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
      }
    }

    // 3. INSERTAR PERSONAL DE APOYO
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsPersLimpios.length > 0) {
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
      }
    }

    // 4. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    // 5. INSERTAR DETALLE DE LLAMADA
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Sin dato",
        ],
      );
    }

    // 6. INSERTAR AGRESORES
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
    }

    // 7. INSERTAR VÍCTIMAS
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
    }

    await connection.commit();

    // 🚀 RESPUESTA INMEDIATA AL USUARIO
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });

    // =========================================================
    // PROCESAR Y SUBIR FOTOS EN SEGUNDO PLANO
    // =========================================================
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(
        (err) => {
          console.error(
            "🔴 Error crítico general en segundo plano de fotos:",
            err.message,
          );
        },
      );
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    if (!res.headersSent) {
      res.status(400).json({ success: false, error: error.message });
    }
  } finally {
    if (connection) connection.release();
  }
});


// Funcion bd)
app.post("/ocurrencias/registrar/modr2s", async (req, res) => {
  let connection;
  try {
    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      estadoOcurrencia,
      vehiculos_detalle,
      id_personal_ids,
      detalle_llamada,
      agresores_detalle,
      victimas_detalle,
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      estadoOcurrencia, // <-- Pasamos la variable dinámica aquí
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
      }
    }

    // 3. INSERTAR PERSONAL DE APOYO
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsPersLimpios.length > 0) {
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
      }
    }

    // 4. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    // 5. INSERTAR DETALLE DE LLAMADA
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Anónimo",
        ],
      );
    }

    // 6. INSERTAR AGRESORES
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
    }

    // 7. INSERTAR VÍCTIMAS
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
    }

    await connection.commit();

    // 🚀 RESPUESTA INMEDIATA AL USUARIO
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });

    // =========================================================
    // PROCESAR Y SUBIR FOTOS A R2 EN SEGUNDO PLANO
    // =========================================================
    // =========================================================
    // PROCESAR Y SUBIR FOTOS A R2 EN SEGUNDO PLANO
    // =========================================================
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(
        (err) => {
          console.error(
            "🔴 Error crítico general en segundo plano de fotos:",
            err.message,
          );
        },
      );
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    if (!res.headersSent) {
      res.status(400).json({ success: false, error: error.message });
    }
  } finally {
    if (connection) connection.release();
  }
});



app.post("/ocurrencias/registrar/modr3", async (req, res) => {
  let connection;
  try {
    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      
      fotos,
      estadoOcurrencia,
      vehiculos_detalle,
      id_personal_ids,
      detalle_llamada,
      agresores_detalle,
      victimas_detalle,
    } = req.body;

    // 🔍 LOG 1: BODY ENTRANTE COMPLETO
    console.log("--------------------------------------------------");
    console.log("📥 [REQ.BODY RECIBIDO]:", JSON.stringify(req.body, null, 2));

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`;

    const paramsOcurrencia = [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      estadoOcurrencia,
      grupo,
    ];

    // 🔍 LOG 2: CONSULTA Y PARÁMETROS REALES DE OCURRENCIA
    console.log("🗄️ [SQL OCURRENCIA]:", sqlOcurrencia);
    console.log("📌 [PARAMS OCURRENCIA]:", paramsOcurrencia);

    const [resOcurrencia] = await connection.query(sqlOcurrencia, paramsOcurrencia);
    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        console.log("📸 [SQL CÁMARAS PARAMS]:", valuesCamara);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
      }
    }

    // 3. INSERTAR PERSONAL DE APOYO
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));
      if (idsPersLimpios.length > 0) {
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        console.log("👮 [SQL PERSONAL PARAMS]:", valuesPersonal);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
      }
    }

    // 4. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      console.log("🚗 [SQL VEHÍCULOS PARAMS]:", valuesV);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    // 5. INSERTAR DETALLE DE LLAMADA
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      console.log("📞 [SQL LLAMADA PARAMS]:", [
        id_nueva_ocurrencia,
        detalle_llamada.numero_telefono,
        detalle_llamada.nombre_informante || "Anónimo",
      ]);
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Anónimo",
        ],
      );
    }

    // 6. INSERTAR AGRESORES
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      console.log("⚠️ [SQL AGRESORES PARAMS]:", valuesAgresores);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
    }

    // 7. INSERTAR VÍCTIMAS
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      console.log("🛡️ [SQL VÍCTIMAS PARAMS]:", valuesVictimas);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
    }

    await connection.commit();
    console.log(`✅ [TRANSACCIÓN EXITOSA] Ocurrencia ID: ${id_nueva_ocurrencia}`);
    console.log("--------------------------------------------------");

    res.status(201).json({ success: true, id: id_nueva_ocurrencia });

    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(
        (err) => {
          console.error(
            "🔴 Error crítico general en segundo plano de fotos:",
            err.message,
          );
        },
      );
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    if (!res.headersSent) {
      res.status(400).json({ success: false, error: error.message });
    }
  } finally {
    if (connection) connection.release();
  }
});


// --- 1. LOGIN (ACTUALIZADO SEGÚN TU IMAGEN) ---
app.post("/loginantes", async (req, res) => {
  try {
    const { usuario, contrasena } = req.body;

    // Unimos usuarios_sistema con la tabla persona para obtener el nombre real
    const sql = `
            SELECT 
                u.id_usuario as id, 
                u.usuario, 
                p.nombres, 
                p.apellido_paterno, 
                p.apellido_materno,
                r.nombre_rol as rol
            FROM usuarios_sistema u
            INNER JOIN persona p ON u.id_persona = p.id_persona
            LEFT JOIN sistema_roles r ON u.id_rol = r.id_rol
            WHERE u.usuario = ? AND u.contrasena = ? AND u.acceso_habilitado = 1
        `;

    const [results] = await db.query(sql, [usuario, contrasena]);

    if (results.length > 0) {
      // Ahora enviamos el objeto completo con nombres y apellidos
      res.json(results[0]);
    } else {
      res
        .status(401)
        .json({ message: "Credenciales incorrectas o acceso deshabilitado" });
    }
  } catch (err) {
    console.error("❌ Error en Login:", err);
    res.status(500).json({ message: "Error interno", error: err.message });
  }
});
// --- 3. REPORTAR para ingresr a ocurre_registro  ---
// 1. LISTAR (Con url_imagen corregido)
app.get("/ocurrencias", async (req, res) => {
  try {
    const sql = `
            SELECT o.id_ocurrencia AS id, o.descripcion, o.fecha_reporte AS fecha, o.referencia AS lugar,
                   m.nombre AS modalidad, f.foto AS url_foto,
                   CONCAT(p.nombres, ' ', p.apellido_paterno) AS registrado_por
            FROM ocurrencia_registro o
            LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
            LEFT JOIN usuarios_sistema u ON o.id_usuario = u.id_usuario
            LEFT JOIN persona p ON u.id_persona = p.id_persona
            LEFT JOIN (SELECT id_ocurrencia, MIN(url_imagen) as foto FROM foto_ocurrencia_registro GROUP BY id_ocurrencia) f 
            ON o.id_ocurrencia = f.id_ocurrencia
            ORDER BY o.fecha_reporte DESC`;
    const [results] = await db.query(sql);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. para cmabiar la ontrseñaconst bcrypt = require('bcrypt');
const bcrypt = require("bcryptjs");

// --- LOGIN CON LOGS DE AUDITORÍA ---
app.post("/loginb", async (req, res) => {
  const { usuario, contrasena } = req.body;

  try {
    const [rows] = await db.query(
      "SELECT * FROM usuarios_sistema WHERE usuario = ?",
      [usuario],
    );
    if (rows.length === 0)
      return res.status(401).json({ message: "Usuario no existe" });

    const user = rows[0];
    const passBD = user.contrasena.toString().trim(); // Limpiamos espacios
    const claveRecibida = contrasena.toString();

    let esValida = false;

    // Verificamos si es un hash de Bcrypt (Empiezan con $2a$, $2b$ o $2y$)
    if (passBD.startsWith("$2")) {
      esValida = await bcrypt.compare(claveRecibida, passBD);
      console.log("Validación por Bcrypt:", esValida);
    } else {
      // Validación por texto plano (para usuarios antiguos)
      esValida = claveRecibida === passBD;
      console.log("Validación por texto plano:", esValida);
    }

    if (esValida) {
      res.json({
        id: user.id,
        nombres: user.nombres,
        usuario: user.usuario,
      });
    } else {
      res.status(401).json({ message: "Clave incorrecta" });
    }
  } catch (error) {
    console.error("Error en login:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});
app.post("/login", async (req, res) => {
  const { usuario, contrasena } = req.body;

  try {
    const sql = `
            SELECT 
                u.id_usuario as id, 
                u.usuario, 
                u.contrasena,
                u.acceso_habilitado,
                u.id_persona,
                u.id_rol, -- <--- 1. AGREGADO: Necesitamos el ID numérico
                p.nombres, 
                p.apellido_paterno, 
                p.apellido_materno,
                r.nombre_rol as rol
            FROM usuarios_sistema u
            INNER JOIN persona p ON u.id_persona = p.id_persona
            LEFT JOIN sistema_roles r ON u.id_rol = r.id_rol
            WHERE u.usuario = ?
        `;

    const [rows] = await db.query(sql, [usuario]);

    if (rows.length === 0) {
      return res.status(401).json({ message: "Credenciales incorrectas" });
    }

    const user = rows[0];

    if (user.acceso_habilitado !== 1) {
      return res
        .status(403)
        .json({ message: "El acceso ha sido deshabilitado" });
    }

    const passBD = user.contrasena.toString().trim();
    const claveRecibida = contrasena.toString();
    let esValida = false;
    let requiereMigracion = false;

    if (passBD.startsWith("$2")) {
      esValida = await bcrypt.compare(claveRecibida, passBD);
    } else {
      esValida = claveRecibida === passBD;
      requiereMigracion = esValida;
    }

    if (esValida) {
      if (requiereMigracion) {
        const nuevoHash = await bcrypt.hash(claveRecibida, 10);
        await db.query(
          "UPDATE usuarios_sistema SET contrasena = ? WHERE id_usuario = ?",
          [nuevoHash, user.id],
        );
      }

      delete user.contrasena;

      // 2. AGREGADO: Enviamos el id_rol explícitamente al frontend
      res.json({
        id: user.id,
        id_persona: user.id_persona,
        id_rol: user.id_rol, // <--- AHORA EL SIDEBAR LO VERÁ
        usuario: user.usuario,
        nombres: user.nombres,
        apellido_paterno: user.apellido_paterno,
        apellido_materno: user.apellido_materno,
        rol: user.rol,
        nombre_completo:
          `${user.nombres} ${user.apellido_paterno} ${user.apellido_materno}`.trim(),
      });
    } else {
      res.status(401).json({ message: "Credenciales incorrectas" });
    }
  } catch (error) {
    console.error("❌ Error en Login:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});
// --- CAMBIO DE CONTRASEÑA ---
app.put("/api/usuarios/cambiar-password", async (req, res) => {
  const { usuario, pass_actual, nueva_pass } = req.body;

  try {
    // 1. Buscamos al usuario para obtener su contraseña actual (hash o texto plano)
    const [rows] = await db.query(
      "SELECT contrasena FROM usuarios_sistema WHERE usuario = ?",
      [usuario],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const passBD = rows[0].contrasena.toString().trim();
    let esValida = false;

    // 2. Verificamos si la contraseña actual coincide
    if (passBD.startsWith("$2")) {
      esValida = await bcrypt.compare(pass_actual.toString(), passBD);
    } else {
      esValida = pass_actual.toString() === passBD;
    }

    if (!esValida) {
      console.log(
        `>>> Intento fallido de cambio para: ${usuario} (Clave actual incorrecta)`,
      );
      return res
        .status(401)
        .json({ message: "La contraseña actual es incorrecta" });
    }

    // 3. Si es válida, encriptamos la NUEVA y guardamos
    const nuevoHash = await bcrypt.hash(nueva_pass.toString(), 10);
    await db.query(
      "UPDATE usuarios_sistema SET contrasena = ? WHERE usuario = ?",
      [nuevoHash, usuario],
    );

    console.log(`>>> Password actualizada con éxito para: ${usuario}`);
    res.json({ message: "OK" });
  } catch (error) {
    console.error("Error en cambio de password:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
// 2. INSERTAR (Validando FKs obligatorios)
app.post("/reportar-nuevo", async (req, res) => {
  const {
    id_usuario,
    id_modalidad,
    descripcion,
    direccion,
    latitud,
    longitud,
    foto,
  } = req.body;

  try {
    // 1. Guardar la ocurrencia (id_tipo_ocurrencia es 1 por defecto según tu SQL)
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
    id_tipo_ocurrencia, descripcion, hora_alerta, hora_llegada, 
    hora_repliegue, id_lugar, id_usuario, id_modalidad, 
    latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
    unidad_encargada, fecha_reporte, fecha_evento, estado, grupo, id_origen
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`;
    const [result] = await connection.query(sqlOcurrencia, [
      id_tipo_ocurrencia,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      id_lugar,
      id_usuario,
      id_modalidad,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento, // El campo que agregamos para ayer/hoy
      estado || 1,
      grupo,
      id_origen, // Este es el que causaba el error 500
    ]);
    const id_nueva_ocurrencia = result.insertId;

    // 2. Guardar la foto vinculada
    if (foto && id_nueva_ocurrencia) {
      const sqlFoto = `INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, fecha_subida) VALUES (?, ?, NOW())`;
      await db.query(sqlFoto, [id_nueva_ocurrencia, foto]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// 3. ELIMINAR
app.delete("/ocurrencia/:id", async (req, res) => {
  try {
    await db.query(
      "DELETE FROM foto_ocurrencia_registro WHERE id_ocurrencia = ?",
      [req.params.id],
    );
    await db.query("DELETE FROM ocurrencia_registro WHERE id_ocurrencia = ?", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 2. REPORTAR el primerop ---
app.post("/reportar", async (req, res) => {
  try {
    const {
      usuario_id,
      modalidad_id,
      descripcion,
      fotos,
      latitud,
      longitud,
      area,
      lugar,
    } = req.body;

    const sql1 = `INSERT INTO ocurrencias 
                      (usuario_id, modalidad_id, descripcion, latitud, longitud, area, lugar, fecha) 
                      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`;

    const [resultOcc] = await db.query(sql1, [
      usuario_id,
      modalidad_id,
      descripcion,
      latitud || 0,
      longitud || 0,
      area || "App",
      lugar || "Ubicación detectada",
    ]);

    const ocurrenciaId = resultOcc.insertId;

    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const values = fotos.map((url) => [ocurrenciaId, url]);
      // Importante: mysql2 usa esta sintaxis para inserts múltiples
      await db.query(
        "INSERT INTO fotos_ocurrencia (ocurrencia_id, url_foto) VALUES ?",
        [values],
      );
    }

    res.json({ success: true, id: ocurrenciaId });
  } catch (err) {
    console.error("❌ Error en reporte:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 3. CATEGORÍAS ---
app.get("/categorias-full", async (req, res) => {
  try {
    const query = `
            SELECT 
                g.id AS gen_id, g.nombre AS gen_nombre, 
                e.id AS esp_id, e.nombre AS esp_nombre, 
                m.id AS mod_id, m.nombre AS mod_nombre 
            FROM cat_generica g 
            LEFT JOIN cat_especifica e ON g.id = e.generica_id 
            LEFT JOIN cat_modalidad m ON e.id = m.especifica_id 
            ORDER BY g.nombre, e.nombre, m.nombre`;

    const [results] = await db.query(query);
    res.json(results);
  } catch (err) {
    console.error("❌ Error en categorías:", err);
    res.status(500).json([]);
  }
});

// --- 4. LISTAR REPORTES ---
app.get("/reportes", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    let query = `
            SELECT 
                o.*, 
                m.nombre as nombre_modalidad,
                GROUP_CONCAT(f.url_foto) as lista_fotos
            FROM ocurrencias o
            LEFT JOIN cat_modalidad m ON o.modalidad_id = m.id
            LEFT JOIN fotos_ocurrencia f ON o.id = f.ocurrencia_id
        `;

    const params = [];
    if (usuario_id) {
      query += " WHERE o.usuario_id = ?";
      params.push(usuario_id);
    }

    query += " GROUP BY o.id ORDER BY o.fecha DESC";

    const [results] = await db.query(query, params);

    const procesados = results.map((row) => ({
      ...row,
      fotos: row.lista_fotos ? row.lista_fotos.split(",") : [],
    }));

    res.json(procesados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- actualizar ---
app.post("/actualizar-turno", async (req, res) => {
  try {
    const { id_persona, fecha, sigla_turno } = req.body;

    // 1. Buscamos el ID del turno (ej: 'M' -> id 1)
    const [turnos] = await db.query("SELECT id FROM turno WHERE sigla = ?", [
      sigla_turno,
    ]);

    if (turnos.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Turno inválido" });
    }

    const id_turno = turnos[0].id;

    // 2. Insertamos o actualizamos (Esto activa tu trigger de auditoría)
    const sql = `
            INSERT INTO jornada_laboral (id_persona, id_turno, fecha_dia)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE id_turno = VALUES(id_turno)
        `;

    await db.query(sql, [id_persona, id_turno, fecha]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 5. CRUD PERSONA ---

// A. Obtener todas las personas (Listar)
// LISTAR PERSONAS (GET)
// Endpoint: GET /personas
// Endpoint: GET /personas
app.get("/personas", async (req, res) => {
  try {
    const { q, unidad, regimen } = req.query;
    let params = [];

    // Consulta base con INNER JOIN para traer el nombre de la unidad
    let sql = `
            SELECT 
                p.id_persona, p.nombres, p.apellido_paterno, p.apellido_materno, 
                p.documento_numero, p.regimen, p.estado_laboral, p.foto_perfil,
                uo.nombre_unidad, p.id_unidad
            FROM persona p
            INNER JOIN unidad_organica uo ON p.id_unidad = uo.id_unidad
            WHERE 1=1
        `;

    // Filtro por Régimen (si no es TODOS)
    if (regimen && regimen !== "TODOS") {
      sql += ` AND p.regimen = ?`;
      params.push(regimen);
    }

    // Filtro por Unidad Orgánica
    if (unidad) {
      sql += ` AND p.id_unidad = ?`;
      params.push(unidad);
    }

    // Búsqueda "Implacable" por términos independientes
    if (q) {
      const terms = q.trim().split(/\s+/);
      terms.forEach((term) => {
        sql += ` AND (p.nombres LIKE ? OR p.apellido_paterno LIKE ? OR p.apellido_materno LIKE ? OR p.documento_numero LIKE ?)`;
        const pattern = `%${term}%`;
        params.push(pattern, pattern, pattern, pattern);
      });
    }

    sql += ` ORDER BY p.apellido_paterno ASC`;

    const [results] = await db.query(sql, params);
    res.json(results);
  } catch (err) {
    console.error("Error en DB:", err);
    res.status(500).json({ message: "Error al obtener datos" });
  }
});

// lsitar undiad organica
app.get("/unidades", async (req, res) => {
  try {
    const sql = `
      SELECT 
        uo.id_unidad,
        CONCAT(uo.nombre_unidad, ' (', s.siglasub, ')') AS nombre_unidad
      FROM unidad_organica AS uo 
      INNER JOIN subgerencia AS s ON s.id_subgerencia = uo.id_subgerencia
      ORDER BY uo.nombre_unidad ASC`;

    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Error al obtener unidades:", err);
    res.status(500).json({ error: err.message });
  }
});
// GET /personas
app.get("/personas1", async (req, res) => {
  try {
    const { q, unidad, regimen, estado, page = 1 } = req.query;
    const limit = 20;
    const offset = (Number(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1"; // Base para añadir filtros dinámicos

    // 1. Construcción del WHERE dinámico
    if (q) {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (p.nombres LIKE ? OR p.apellido_paterno LIKE ? OR p.apellido_materno LIKE ? OR p.documento_numero LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt, patt);
      });
    }

    if (regimen && regimen !== "TODOS") {
      where += ` AND p.regimen = ?`;
      params.push(regimen);
    }
    if (unidad) {
      where += ` AND p.id_unidad = ?`;
      params.push(unidad);
    }
    if (estado && estado !== "TODOS") {
      where += ` AND p.estado_laboral = ?`;
      params.push(estado);
    }

    // 2. CAMBIO CRÍTICO: Inyectar la variable 'where' en la consulta
    const sql = `SELECT p.*, uo.nombre_unidad 
                     FROM persona p 
                     INNER JOIN unidad_organica uo ON p.id_unidad = uo.id_unidad 
                     ${where} 
                     ORDER BY p.id_persona DESC LIMIT ? OFFSET ?`;

    // 3. Consulta de conteos (la mantenemos igual o podrías filtrarla también)
    const sqlCounts = `
            SELECT 
                (SELECT COUNT(*) FROM persona) as total,
                (SELECT COUNT(*) FROM persona WHERE estado_laboral = 'ACTIVO') as activos,
                (SELECT COUNT(*) FROM persona WHERE estado_laboral = 'INACTIVO') as inactivos,
                regimen, COUNT(*) as reg_total 
            FROM persona GROUP BY regimen`;

    // Ejecución con los parámetros en el orden correcto
    const [results] = await db.query(sql, [...params, limit, offset]);
    const [countsData] = await db.query(sqlCounts);

    res.json({
      data: results,
      counts: countsData,
      hasMore: results.length === limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// GET /personastotal
app.get("/personastotalseg", async (req, res) => {
  try {
    const { q, unidad, regimen, estado, page = 1 } = req.query;
    const limit = 20;
    const offset = (Number(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1";

    // 1. Filtros dinámicos
    if (q) {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (p.nombres LIKE ? OR p.apellido_paterno LIKE ? OR p.apellido_materno LIKE ? OR p.documento_numero LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt, patt);
      });
    }

    if (regimen && regimen !== "TODOS") {
      where += ` AND p.regimen = ?`;
      params.push(regimen);
    }
    if (unidad) {
      where += ` AND p.id_unidad = ?`;
      params.push(unidad);
    }
    if (estado && estado !== "TODOS") {
      where += ` AND p.estado_laboral = ?`;
      params.push(estado);
    }

    // 2. Consulta SQL de personas (Se removió us.clave y se cambió a LEFT JOIN)
    const sql = `SELECT 
                    p.*, 
                    uo.nombre_unidad,
                    us.usuario,
                    sr.nombre_rol,
                    sr.descripcion as descripcion_rol
                 FROM persona p 
                 LEFT JOIN unidad_organica uo ON p.id_unidad = uo.id_unidad 
                 LEFT JOIN usuarios_sistema us ON p.id_persona = us.id_persona
                 LEFT JOIN sistema_roles sr ON us.id_rol = sr.id_rol
                 ${where} 
                 ORDER BY p.id_persona DESC 
                 LIMIT ? OFFSET ?`;

    // 3. Consulta de conteos basada en los filtros aplicados
    const sqlCounts = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN p.estado_laboral = 'ACTIVO' THEN 1 END) as activos,
        COUNT(CASE WHEN p.estado_laboral = 'INACTIVO' THEN 1 END) as inactivos
      FROM persona p
      ${where}`;

    // Ejecución paralela de consultas
    const [[results], [countsData]] = await Promise.all([
      db.query(sql, [...params, limit, offset]),
      db.query(sqlCounts, params),
    ]);

    const totalRecords = countsData[0]?.total || 0;

    res.json({
      data: results,
      counts: countsData[0] || { total: 0, activos: 0, inactivos: 0 },
      pagination: {
        currentPage: Number(page),
        limit,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasMore: offset + results.length < totalRecords,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/personastotal", async (req, res) => {
  try {
    const { q, unidad, regimen, estado, page = 1, export: isExport } = req.query;
    const limit = 20;
    const offset = (Number(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1";

    // 1. Buscador global
    if (q && q.trim() !== "") {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (p.nombres LIKE ? OR p.apellido_paterno LIKE ? OR p.apellido_materno LIKE ? OR p.documento_numero LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt, patt);
      });
    }

    // 2. Filtros dinámicos
    if (regimen && regimen !== "TODOS") {
      where += ` AND p.regimen = ?`;
      params.push(regimen);
    }

    if (unidad && unidad !== "TODOS") {
      where += ` AND p.id_unidad = ?`;
      params.push(unidad);
    }

    if (estado && estado !== "TODOS") {
      where += ` AND p.estado_laboral = ?`;
      params.push(estado);
    }

    // Exportación a Excel completa
    if (isExport === "true") {
      const sqlExport = `
        SELECT 
          p.*, 
          uo.nombre_unidad,
          us.usuario,
          us.id_rol, -- 👈 AGREGADO AQUÍ
          sr.nombre_rol,
          sr.descripcion as descripcion_rol
        FROM persona p 
        LEFT JOIN unidad_organica uo ON p.id_unidad = uo.id_unidad 
        LEFT JOIN usuarios_sistema us ON p.id_persona = us.id_persona
        LEFT JOIN sistema_roles sr ON us.id_rol = sr.id_rol
        ${where} 
        ORDER BY p.apellido_paterno ASC`;

      const [exportResults] = await db.query(sqlExport, params);
      return res.json({ data: exportResults });
    }

    // 3. Consulta estándar con paginación
    const sqlData = `
      SELECT 
        p.*, 
        uo.nombre_unidad,
        us.usuario,
        us.id_rol, -- 👈 AGREGADO AQUÍ: Trae el id_rol de usuarios_sistema
        sr.nombre_rol,
        sr.descripcion as descripcion_rol
      FROM persona p 
      LEFT JOIN unidad_organica uo ON p.id_unidad = uo.id_unidad 
      LEFT JOIN usuarios_sistema us ON p.id_persona = us.id_persona
      LEFT JOIN sistema_roles sr ON us.id_rol = sr.id_rol
      ${where} 
      ORDER BY p.id_persona DESC 
      LIMIT ? OFFSET ?`;

    const sqlCounts = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN p.estado_laboral = 'ACTIVO' THEN 1 END) as activos,
        COUNT(CASE WHEN p.estado_laboral = 'INACTIVO' THEN 1 END) as inactivos
      FROM persona p
      ${where}`;

    // Ejecución paralela
    const [[results], [countsData]] = await Promise.all([
      db.query(sqlData, [...params, limit, offset]),
      db.query(sqlCounts, params),
    ]);

    const totalRecords = countsData[0]?.total || 0;

    res.json({
      data: results,
      counts: countsData[0] || { total: 0, activos: 0, inactivos: 0 },
      pagination: {
        currentPage: Number(page),
        limit,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasMore: offset + results.length < totalRecords,
      },
    });
  } catch (err) {
    console.error("Error en /personastotal:", err);
    res.status(500).json({ error: err.message });
  }
});
app.get("/pnptotal", async (req, res) => {
  try {
    const { q, grado, estado, page = 1, export: isExport } = req.query;
    const limit = 20;
    const offset = (Number(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1";

    // 1. Buscador global (Nombres, Apellidos o DNI)
    if (q && q.trim() !== "") {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (p.nombres LIKE ? OR p.apellidos LIKE ? OR p.dni LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt);
      });
    }

    // 2. Filtros dinámicos
    if (grado && grado !== "TODOS") {
      where += ` AND p.grado = ?`;
      params.push(grado);
    }

    if (estado && estado !== "TODOS") {
      where += ` AND p.estado = ?`;
      params.push(Number(estado));
    }

    // Exportación a Excel completa
    if (isExport === "true") {
      const sqlExport = `
        SELECT p.* 
        FROM cat_pnp p 
        ${where} 
        ORDER BY p.id_pnp DESC`;

      const [exportResults] = await db.query(sqlExport, params);
      return res.json({ data: exportResults });
    }

    // 3. Consulta con paginación (Ordenado por id_pnp DESC)
    const sqlData = `
      SELECT p.* 
      FROM cat_pnp p 
      ${where} 
      ORDER BY p.id_pnp DESC 
      LIMIT ? OFFSET ?`;

    // Conteo para cat_pnp (1: Activo, 0: Inactivo)
    const sqlCounts = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN p.estado = 1 THEN 1 END) as activos,
        COUNT(CASE WHEN p.estado = 0 THEN 1 END) as inactivos
      FROM cat_pnp p
      ${where}`;

    // Ejecución en paralelo
    const [[results], [countsData]] = await Promise.all([
      db.query(sqlData, [...params, limit, offset]),
      db.query(sqlCounts, params),
    ]);

    const totalRecords = countsData[0]?.total || 0;

    res.json({
      data: results,
      counts: countsData[0] || { total: 0, activos: 0, inactivos: 0 },
      pagination: {
        currentPage: Number(page),
        limit,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasMore: offset + results.length < totalRecords,
      },
    });
  } catch (err) {
    console.error("Error en /pnptotal:", err);
    res.status(500).json({ error: err.message });
  }
});
app.put("/updatepnp/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { grado, nombres, apellidos, dni, estado } = req.body;

    // 1. Validación básica de campos requeridos
    if (!grado || !nombres || !apellidos || !dni) {
      return res.status(400).json({
        success: false,
        message: "Los campos grado, nombres, apellidos y dni son obligatorios",
      });
    }

    // 2. Consulta SQL de actualización
    const sql = `
      UPDATE cat_pnp 
      SET 
        grado = ?, 
        nombres = ?, 
        apellidos = ?, 
        dni = ?, 
        estado = ?
      WHERE id_pnp = ?
    `;

    const [result] = await db.query(sql, [
      grado.trim(),
      nombres.toUpperCase().trim(),
      apellidos.toUpperCase().trim(),
      dni.trim(),
      estado !== undefined ? Number(estado) : 1,
      id,
    ]);

    // 3. Verificar si el registro existía
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "No se encontró ningún efectivo PNP con el ID proporcionado",
      });
    }

    res.json({
      success: true,
      message: "Efectivo PNP actualizado correctamente",
    });
  } catch (err) {
    console.error("❌ Error al actualizar cat_pnp:", err);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: err.message,
    });
  }
});
// 1. Endpoint auxiliar para verificar DNI en tiempo real
app.get("/checkdnipnp/:dni", async (req, res) => {
  try {
    const { dni } = req.params;
    const [rows] = await db.query(
      "SELECT id_pnp FROM cat_pnp WHERE dni = ?",
      [dni.trim()]
    );
    res.json({ existe: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Endpoint de Inserción con validación de DNI Duplicado
app.post("/insertpnp", async (req, res) => {
  try {
    const { grado, nombres, apellidos, dni, estado = 1 } = req.body;

    if (!grado || !nombres || !apellidos || !dni) {
      return res.status(400).json({
        success: false,
        message: "Los campos grado, nombres, apellidos y dni son obligatorios",
      });
    }

    // Validación de DNI existente
    const [existente] = await db.query(
      "SELECT id_pnp FROM cat_pnp WHERE dni = ?",
      [dni.trim()]
    );

    if (existente.length > 0) {
      return res.status(409).json({
        success: false,
        code: "DNI_DUPLICADO",
        message: `El DNI ${dni} ya se encuentra registrado en el sistema.`,
      });
    }

    const sql = `
      INSERT INTO cat_pnp 
      (grado, nombres, apellidos, dni, estado) 
      VALUES (?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(sql, [
      grado.trim(),
      nombres.toUpperCase().trim(),
      apellidos.toUpperCase().trim(),
      dni.trim(),
      Number(estado),
    ]);

    res.status(201).json({
      success: true,
      message: "Efectivo PNP registrado correctamente",
      id: result.insertId,
    });
  } catch (err) {
    console.error("❌ Error al insertar en cat_pnp:", err);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: err.message,
    });
  }
});

// 1. Obtener Flota Municipal con paginación y búsqueda
app.get("/flotatotal", async (req, res) => {
  try {
    const { q, tipo_servicio, estado, id_tipo_vehiculo, page = 1, export: isExport } = req.query;
    const limit = 20;
    const offset = (Number(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1";

    if (q && q.trim() !== "") {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (f.placa LIKE ? OR f.numero_unidad LIKE ? OR f.marca LIKE ? OR f.modelo LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt, patt);
      });
    }

    if (estado && estado !== "TODOS") {
      where += ` AND f.estado = ?`;
      params.push(Number(estado));
    }

    // NUEVO: Filtro por Tipo de Vehículo
    if (id_tipo_vehiculo && id_tipo_vehiculo !== "TODOS") {
      where += ` AND f.id_tipo_vehiculo = ?`;
      params.push(id_tipo_vehiculo);
    }

    if (isExport === "true") {
      const sqlExport = `
        SELECT f.*, tv.descripcion as tipo_vehiculo_nombre
        FROM sipcop_flota_municipal f
        LEFT JOIN tipo_vehiculo tv ON f.id_tipo_vehiculo = tv.id_tipo_vehiculo
        ${where}
        ORDER BY f.id_unidad DESC`;

      const [exportResults] = await db.query(sqlExport, params);
      return res.json({ data: exportResults });
    }

    const sqlData = `
      SELECT 
        f.*, 
        tv.descripcion as tipo_vehiculo_nombre
      FROM sipcop_flota_municipal f
      LEFT JOIN tipo_vehiculo tv ON f.id_tipo_vehiculo = tv.id_tipo_vehiculo
      ${where}
      ORDER BY f.id_unidad DESC
      LIMIT ? OFFSET ?`;

    const sqlCounts = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN f.estado = 1 THEN 1 END) as activos,
        COUNT(CASE WHEN f.estado = 0 THEN 1 END) as inactivos
      FROM sipcop_flota_municipal f
      ${where}`;

    const [[results], [countsData]] = await Promise.all([
      db.query(sqlData, [...params, limit, offset]),
      db.query(sqlCounts, params),
    ]);

    const totalRecords = countsData[0]?.total || 0;

    res.json({
      data: results,
      counts: countsData[0] || { total: 0, activos: 0, inactivos: 0 },
      pagination: {
        currentPage: Number(page),
        limit,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasMore: offset + results.length < totalRecords,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Verificar Placa Duplicada en tiempo real
app.get("/checkplacacop/:placa", async (req, res) => {
  try {
    const { placa } = req.params;
    const [rows] = await db.query(
      "SELECT id_unidad FROM sipcop_flota_municipal WHERE placa = ?",
      [placa.trim().toUpperCase()]
    );
    res.json({ existe: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Endpoint para actualizar una unidad por id_unidad
app.put("/updateflota/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { placa, id_tipo_vehiculo, numero_unidad, tipo_servicio, marca, modelo, año, estado } = req.body;

    const sql = `
      UPDATE sipcop_flota_municipal 
      SET 
        placa = ?,
        id_tipo_vehiculo = ?,
        numero_unidad = ?,
        tipo_servicio = ?,
        marca = ?,
        modelo = ?,
        año = ?,
        estado = ?
      WHERE id_unidad = ?`;

    const [result] = await db.query(sql, [
      placa ? placa.trim().toUpperCase() : null,
      id_tipo_vehiculo || null,
      numero_unidad || null,
      tipo_servicio || "MUNICIPAL",
      marca || null,
      modelo || null,
      año || null,
      Number(estado),
      id,
    ]);

    res.json({ success: true, message: "Unidad actualizada correctamente" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// 3. Insertar nueva unidad de flota con validación de Placa Duplicada
app.post("/insertflota", async (req, res) => {
  try {
    const { placa, id_tipo_vehiculo, numero_unidad, tipo_servicio, marca, modelo, año, estado = 1 } = req.body;

    if (!placa) {
      return res.status(400).json({ success: false, message: "La placa es obligatoria" });
    }

    // Validar si la placa existe
    const [existente] = await db.query(
      "SELECT id_unidad FROM sipcop_flota_municipal WHERE placa = ?",
      [placa.trim().toUpperCase()]
    );

    if (existente.length > 0) {
      return res.status(409).json({
        success: false,
        code: "PLACA_DUPLICADA",
        message: `La placa ${placa} ya está registrada en el sistema.`,
      });
    }

    const sql = `
      INSERT INTO sipcop_flota_municipal 
      (placa, id_tipo_vehiculo, numero_unidad, tipo_servicio, marca, modelo, año, estado) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    const [result] = await db.query(sql, [
      placa.trim().toUpperCase(),
      id_tipo_vehiculo || null,
      numero_unidad || null,
      tipo_servicio || "MUNICIPAL",
      marca || null,
      modelo || null,
      año || null,
      Number(estado),
    ]);

    res.status(201).json({
      success: true,
      message: "Vehículo registrado correctamente",
      id: result.insertId,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// Endpoint para obtener el listado de tipos de vehículo para los select/pickers
app.get("/tiposvehiculo", async (req, res) => {
  try {
    const sql = `
      SELECT 
        id_tipo_vehiculo, 
        descripcion, 
        modalidad 
      FROM tipo_vehiculo 
      ORDER BY descripcion ASC`;

    const [rows] = await db.query(sql);
    
    // Retorna el array directamente o dentro del objeto
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Error al obtener tipos de vehículo:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ==========================================
/// ==========================================
// 1. OBTENER CATÁLOGOS PARA EL FRONTEND
// ==========================================
app.get("/lugar-catalogos", async (req, res) => {
  try {
    const [tiposLugar] = await db.query(
      "SELECT id_tipo, nombre_tipo FROM tipos_lugar"
    );
    const [tiposVia] = await db.query(
      "SELECT id_tipo_via, abreviatura FROM tipo_via WHERE estado = 1"
    );
    const [vias] = await db.query(
      "SELECT id_via, id_tipo_via, nombre_via FROM via WHERE estado = 1"
    );
    const [cuadras] = await db.query(
      "SELECT id_cuadra, numero_cuadra FROM cuadra ORDER BY numero_cuadra ASC"
    );

    res.json({
      tiposLugar,
      tiposVia,
      vias,
      cuadras,
    });
  } catch (err) {
    console.error("❌ Error en /lugar-catalogos:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. LISTADO DE LUGARES (PAGINACIÓN, FILTROS Y EXPORT)
// ==========================================
app.get("/lugarestotal", async (req, res) => {
  try {
    const { q, tipo, via, cuadra, estado, page = 1, export: isExport } = req.query;
    const limit = 20;
    const offset = (Number(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1";

    if (q && q.trim() !== "") {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (l.nombre_lugar LIKE ? OR l.unidad_encargada LIKE ? OR v.nombre_via LIKE ? OR c.numero_cuadra LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt, patt);
      });
    }

    if (tipo && tipo !== "TODOS") {
      where += ` AND l.id_tipo_lugar = ?`;
      params.push(tipo);
    }

    if (via && via !== "TODOS") {
      where += ` AND l.id_via = ?`;
      params.push(via);
    }

    if (cuadra && cuadra !== "TODOS") {
      where += ` AND l.id_cuadra = ?`;
      params.push(cuadra);
    }

    if (estado && estado !== "TODOS") {
      where += ` AND l.estado = ?`;
      params.push(Number(estado));
    }

    if (isExport === "true") {
      const sqlExport = `
        SELECT 
          l.id_lugar,
          l.nombre_lugar,
          l.id_tipo_lugar,
          tl.nombre_tipo AS tipo_descripcion,
          l.id_via,
          v.id_tipo_via,
          v.nombre_via,
          l.id_cuadra,
          c.numero_cuadra,
          l.unidad_encargada,
          l.latitud,
          l.longitud,
          l.estado
        FROM lugar l
        LEFT JOIN tipos_lugar tl ON l.id_tipo_lugar = tl.id_tipo
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        ${where} 
        ORDER BY l.id_lugar DESC`;

      const [exportResults] = await db.query(sqlExport, params);
      return res.json({ data: exportResults });
    }

    const sqlData = `
      SELECT 
        l.id_lugar,
        l.nombre_lugar,
        l.id_tipo_lugar,
        tl.nombre_tipo AS tipo_descripcion,
        l.id_via,
        v.id_tipo_via,
        v.nombre_via,
        l.id_cuadra,
        c.numero_cuadra,
        l.unidad_encargada,
        l.latitud,
        l.longitud,
        l.estado
      FROM lugar l
      LEFT JOIN tipos_lugar tl ON l.id_tipo_lugar = tl.id_tipo
      LEFT JOIN via v ON l.id_via = v.id_via
      LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
      ${where} 
      ORDER BY l.id_lugar DESC 
      LIMIT ? OFFSET ?`;

    const sqlCounts = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN l.estado = 1 THEN 1 END) as activos,
        COUNT(CASE WHEN l.estado = 0 THEN 1 END) as inactivos
      FROM lugar l
      LEFT JOIN via v ON l.id_via = v.id_via
      LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
      ${where}`;

    const [[results], [countsData]] = await Promise.all([
      db.query(sqlData, [...params, limit, offset]),
      db.query(sqlCounts, params),
    ]);

    const totalRecords = countsData[0]?.total || 0;

    res.json({
      data: results,
      counts: countsData[0] || { total: 0, activos: 0, inactivos: 0 },
      pagination: {
        currentPage: Number(page),
        limit,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasMore: offset + results.length < totalRecords,
      },
    });
  } catch (err) {
    console.error("❌ Error en /lugarestotal:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. ACTUALIZAR REGISTRO EN LUGAR
// ==========================================
app.put("/updatelugar/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_lugar, id_tipo_lugar, id_via, id_cuadra, latitud, longitud, estado, unidad_encargada } = req.body;

    if (id_tipo_lugar == null || id_via == null || id_cuadra == null) {
      return res.status(400).json({
        success: false,
        message: "Los campos id_tipo_lugar, id_via y id_cuadra son obligatorios",
      });
    }

    const [existente] = await db.query(
      "SELECT id_lugar FROM lugar WHERE id_via = ? AND id_cuadra = ? AND id_lugar != ?",
      [id_via, id_cuadra, id]
    );

    if (existente.length > 0) {
      return res.status(409).json({
        success: false,
        code: "LUGAR_DUPLICADO",
        message: `No se puede actualizar. La Vía ID ${id_via} y Cuadra ID ${id_cuadra} ya pertenecen a otro lugar.`,
      });
    }

    const lat = parseFloat(latitud) || 0;
    const lng = parseFloat(longitud) || 0;
    const point = `POINT(${lng} ${lat})`;

    const sql = `
      UPDATE lugar 
      SET 
        nombre_lugar = ?,
        id_tipo_lugar = ?, 
        id_via = ?, 
        id_cuadra = ?, 
        latitud = ?, 
        longitud = ?, 
        posicion_gps = ST_GeomFromText(?), 
        estado = ?, 
        unidad_encargada = ?
      WHERE id_lugar = ?
    `;

    const [result] = await db.query(sql, [
      nombre_lugar || null,
      Number(id_tipo_lugar),
      Number(id_via),
      Number(id_cuadra),
      lat,
      lng,
      point,
      estado !== undefined ? Number(estado) : 1,
      unidad_encargada ? String(unidad_encargada).toUpperCase().trim() : null,
      id,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "No se encontró ningún lugar registrado con el ID proporcionado",
      });
    }

    res.json({
      success: true,
      message: "Lugar actualizado correctamente",
    });
  } catch (err) {
    console.error("❌ Error al actualizar lugar:", err);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: err.message,
    });
  }
});

// ==========================================
// 4. VERIFICAR DUPLICADO
// ==========================================
app.get("/checklugar/:id_via/:id_cuadra", async (req, res) => {
  try {
    const { id_via, id_cuadra } = req.params;
    const [rows] = await db.query(
      "SELECT id_lugar FROM lugar WHERE id_via = ? AND id_cuadra = ?",
      [id_via, id_cuadra]
    );
    res.json({ existe: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. INSERTAR REGISTRO EN LUGAR
// ==========================================
app.post("/insertlugar", async (req, res) => {
  try {
    const { nombre_lugar, id_tipo_lugar, id_via, id_cuadra, latitud, longitud, estado = 1, unidad_encargada } = req.body;

    if (id_tipo_lugar == null || id_via == null || id_cuadra == null) {
      return res.status(400).json({
        success: false,
        message: "Los campos id_tipo_lugar, id_via y id_cuadra son obligatorios",
      });
    }

    const [existente] = await db.query(
      "SELECT id_lugar FROM lugar WHERE id_via = ? AND id_cuadra = ?",
      [id_via, id_cuadra]
    );

    if (existente.length > 0) {
      return res.status(409).json({
        success: false,
        code: "LUGAR_DUPLICADO",
        message: `El lugar con la Vía ID ${id_via} y Cuadra ID ${id_cuadra} ya se encuentra registrado.`,
      });
    }

    const lat = parseFloat(latitud) || 0;
    const lng = parseFloat(longitud) || 0;
    const point = `POINT(${lng} ${lat})`;

    const sql = `
      INSERT INTO lugar 
      (nombre_lugar, id_tipo_lugar, id_via, id_cuadra, latitud, longitud, posicion_gps, estado, unidad_encargada) 
      VALUES (?, ?, ?, ?, ?, ?, ST_GeomFromText(?), ?, ?)
    `;

    const [result] = await db.query(sql, [
      nombre_lugar || null,
      Number(id_tipo_lugar),
      Number(id_via),
      Number(id_cuadra),
      lat,
      lng,
      point,
      Number(estado),
      unidad_encargada ? String(unidad_encargada).toUpperCase().trim() : "SERENAZGO",
    ]);

    res.status(201).json({
      success: true,
      message: "Lugar registrado correctamente",
      id: result.insertId,
    });
  } catch (err) {
    console.error("❌ Error al insertar en lugar:", err);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: err.message,
    });
  }
});

// GET /edit contraseñas
// Endpoint administrativo: No requiere la clave anterior
app.put("/admin/reset-passwordseg/:id_persona", async (req, res) => {
  try {
    const { id_persona } = req.params;
    const { nuevaClave } = req.body;

    if (!nuevaClave || nuevaClave.trim().length < 4) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres" });
    }

    // Si usas bcrypt (recomendado):
    // const hash = await bcrypt.hash(nuevaClave, 10);
    // const [result] = await db.query("UPDATE usuarios_sistema SET clave = ? WHERE id_persona = ?", [hash, id_persona]);

    const [result] = await db.query(
      "UPDATE usuarios_sistema SET contrasena = ? WHERE id_persona = ?",
      [nuevaClave, id_persona]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "El usuario no tiene una cuenta de sistema vinculada." });
    }

    res.json({ message: "Contraseña restablecida con éxito por el administrador" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put("/admin/reset-password/:id_persona", async (req, res) => {
  try {
    const { id_persona } = req.params;
    const { id_rol, nuevaClave, contrasena, acceso_habilitado } = req.body;

    // 1. Extraer y validar la contraseña (si se envió)
    const passwordInput = nuevaClave || contrasena;
    const tieneNuevaClave = passwordInput && String(passwordInput).trim().length > 0;

    if (tieneNuevaClave && String(passwordInput).trim().length < 4) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres." });
    }

    // 2. Construir la consulta dinámicamente solo con los campos enviados
    const updates = [];
    const values = [];

    if (tieneNuevaClave) {
      updates.push("contrasena = ?");
      values.push(String(passwordInput).trim());
    }

    if (id_rol !== undefined && id_rol !== null) {
      updates.push("id_rol = ?");
      values.push(id_rol);
    }

    if (acceso_habilitado !== undefined && acceso_habilitado !== null) {
      updates.push("acceso_habilitado = ?");
      values.push(acceso_habilitado);
    }

    // Si no enviaron ningún campo para modificar
    if (updates.length === 0) {
      return res.status(400).json({ error: "No se envió ningún dato para actualizar." });
    }

    // Agregar id_persona al final del arreglo de parámetros SQL
    values.push(id_persona);

    const query = `UPDATE usuarios_sistema SET ${updates.join(", ")} WHERE id_persona = ?`;
    const [result] = await db.query(query, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "El usuario no tiene una cuenta de sistema vinculada." });
    }

    res.json({ message: "Datos actualizados con éxito." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// jalarroles
// Obtener todos los roles disponibles
app.get("/admin/roles", async (req, res) => {
  try {
    const [roles] = await db.query(
      "SELECT id_rol, nombre_rol, descripcion FROM sistema_roles"
    );
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// RUTA: LISTADO CON PAGINACIÓN POR HOJAS
app.get("/personas3", async (req, res) => {
  try {
    const { q, unidad, regimen, estado, page = 1 } = req.query;
    const limit = 15; // Cantidad fija por hoja
    const offset = (parseInt(page) - 1) * limit;

    let params = [];
    let where = "WHERE 1=1";

    if (q) {
      const terms = q.trim().split(/\s+/);
      terms.forEach((t) => {
        where += ` AND (p.nombres LIKE ? OR p.apellido_paterno LIKE ? OR p.documento_numero LIKE ?)`;
        const patt = `%${t}%`;
        params.push(patt, patt, patt);
      });
    }

    // Filtros adicionales
    if (regimen && regimen !== "TODOS") {
      where += ` AND p.regimen = ?`;
      params.push(regimen);
    }
    if (unidad) {
      where += ` AND p.id_unidad = ?`;
      params.push(unidad);
    }
    if (estado && estado !== "TODOS") {
      where += ` AND p.estado_laboral = ?`;
      params.push(estado);
    }

    const sql = `SELECT p.*, uo.nombre_unidad FROM persona p 
                     INNER JOIN unidad_organica uo ON p.id_unidad = uo.id_unidad 
                     ${where} ORDER BY p.apellido_paterno ASC LIMIT ? OFFSET ?`;

    const [results] = await db.query(sql, [...params, limit, offset]);

    // Calcular total de páginas
    const [countRes] = await db.query(
      `SELECT COUNT(*) as total FROM persona p ${where}`,
      params,
    );
    const totalPages = Math.ceil(countRes[0].total / limit);

    res.json({
      data: results,
      totalPages,
      currentPage: parseInt(page),
      totalItems: countRes[0].total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. Insertar nueva persona
app.post("/insertpersonas", async (req, res) => {
  try {
    // Extraemos solo los campos necesarios del cuerpo de la petición
    // Los campos id_unidad, id_superior, id_grupo, celular y foto_perfil
    // se reciben pero pueden ser opcionales (vienen como null si no se envían)
    const {
      nombres,
      apellido_paterno,
      apellido_materno,
      documento_numero,
      id_unidad = 26,
      id_superior = null,
      id_grupo = null,
      
      foto_perfil = null,
    } = req.body;

    // SQL Simplificado:
    // No incluimos id_persona porque es NULL/Autoincremental.
    // No incluimos estado_laboral ni regimen porque mencionas que ya tienen DEFAULT en SQL.
    const sql = `
            INSERT INTO persona 
            (nombres, apellido_paterno, apellido_materno, documento_numero, 
             id_unidad, id_superior, id_grupo, foto_perfil) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

    const [result] = await db.query(sql, [
      nombres?.toUpperCase().trim(),
      apellido_paterno?.toUpperCase().trim(),
      apellido_materno?.toUpperCase().trim(),
      documento_numero,
      id_unidad,
      id_superior,
      id_grupo,
      
      foto_perfil,
    ]);

    res.status(201).json({
      success: true,
      message: "Personal registrado correctamente",
      id: result.insertId,
    });
  } catch (err) {
    console.error("❌ Error al insertar persona:", err);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: err.message,
    });
  }
});


// C. Actualizar estado (Para el componente Switch / Slicer)
app.get("/personas/check/:dni", async (req, res) => {
  const [rows] = await db.query(
    "SELECT COUNT(*) as count FROM persona WHERE documento_numero = ?",
    [req.params.dni],
  );
  res.json({ exists: rows[0].count > 0 });
});

// EDITAR PERSONA (PUT)

app.put("/updatepersonaseg/:id", async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const {
      nombres,
      apellido_paterno,
      apellido_materno,
      documento_numero,
      estado_laboral,
      id_unidad,
      id_grupo,
      regimen,
      celular,
      foto_perfil_base64,
    } = req.body;

    // 1. VALIDACIÓN DE DNI DUPLICADO
    // Buscamos si existe otra persona con ese DNI que NO sea el usuario actual
    const [existing] = await db.query(
      "SELECT id_persona FROM persona WHERE documento_numero = ? AND id_persona <> ?",
      [documento_numero, id],
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: "El DNI ya está registrado por otro trabajador.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Manejo de Foto (Cloudinary)
    let final_foto_url = req.body.foto_perfil;
    if (foto_perfil_base64 && foto_perfil_base64.includes("base64")) {
      const uploadRes = await cloudinary.uploader.upload(foto_perfil_base64, {
        upload_preset: "renderizado",
      });
      final_foto_url = uploadRes.secure_url;
    }

    // UPDATE Principal
    const sqlUpdate = `
            UPDATE persona SET 
                nombres = ?, apellido_paterno = ?, apellido_materno = ?, 
                documento_numero = ?, estado_laboral = ?, id_unidad = ?, 
                id_grupo = ?, regimen = ?, celular = ?, foto_perfil = ?
            WHERE id_persona = ?
        `;
    await connection.query(sqlUpdate, [
      nombres?.toUpperCase().trim(),
      apellido_paterno?.toUpperCase().trim(),
      apellido_materno?.toUpperCase().trim(),
      documento_numero,
      estado_laboral,
      id_unidad,
      id_grupo,
      regimen,
      celular,
      final_foto_url,
      id,
    ]);

    // CONSULTA SOLICITADA: Obtener el nombre de la unidad vinculada
    const [rows] = await connection.query(
      `SELECT u.nombre_unidad 
             FROM persona as p 
             INNER JOIN unidad_organica as u ON p.id_unidad = u.id_unidad 
             WHERE p.id_persona = ?`,
      [id],
    );

    await connection.commit();

    res.json({
      success: true,
      nombre_unidad: rows[0]?.nombre_unidad,
      foto_url: final_foto_url,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.put("/updatepersona/:id", async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const {
      nombres,
      apellido_paterno,
      apellido_materno,
      documento_numero,
      estado_laboral,
      id_unidad,
      id_grupo,
      regimen,
      celular,
      foto_perfil_base64,
      correo,
      genero,
    } = req.body;

    // 1. VALIDACIÓN DE DNI DUPLICADO
    const [existing] = await db.query(
      "SELECT id_persona FROM persona WHERE documento_numero = ? AND id_persona <> ?",
      [documento_numero, id]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: "El DNI ya está registrado por otro trabajador.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 2. MANEJO Y SUBIDA DE FOTO A CLOUDFLARE R2
    let final_foto_url = req.body.foto_perfil;

    if (foto_perfil_base64 && foto_perfil_base64.includes("base64")) {
      // Clean header Base64 -> Buffer
      const base64Clean = foto_perfil_base64.replace(/^data:image\/\w+;base64,/, "");
      const bufferOriginal = Buffer.from(base64Clean, "base64");

      // Comprimir / Redimensionar con Sharp
      const bufferOptimizado = await sharp(bufferOriginal)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();

      // Generar nombre único para R2
      const fechaActual = new Date();
      const anio = fechaActual.getFullYear();
      const mes = String(fechaActual.getMonth() + 1).padStart(2, "0");
      const nombreArchivo = `perfiles/${anio}/${mes}/persona_${id}_${Date.now()}.jpg`;

      // Subir a Cloudflare R2
      await r2Client.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: nombreArchivo,
          Body: bufferOptimizado,
          ContentType: "image/jpeg",
        })
      );

      // URL final generada
      final_foto_url = `${PUBLIC_DOMAIN}/${nombreArchivo}`;
    }

    // 3. UPDATE Principal
    const sqlUpdate = `
      UPDATE persona SET 
        nombres = ?, apellido_paterno = ?, apellido_materno = ?, 
        documento_numero = ?, estado_laboral = ?, id_unidad = ?, 
        id_grupo = ?, regimen = ?, celular = ?, foto_perfil = ?,
        correo = ?, genero = ?
      WHERE id_persona = ?
    `;

    await connection.query(sqlUpdate, [
      nombres?.toUpperCase().trim(),
      apellido_paterno?.toUpperCase().trim(),
      apellido_materno?.toUpperCase().trim(),
      documento_numero,
      estado_laboral,
      id_unidad,
      id_grupo,
      regimen,
      celular,
      final_foto_url,
      correo?.toLowerCase().trim() || null,
      genero?.toUpperCase().trim() || null,
      id,
    ]);

    // Obtener el nombre de la unidad vinculada
    const [rows] = await connection.query(
      `SELECT u.nombre_unidad 
       FROM persona as p 
       INNER JOIN unidad_organica as u ON p.id_unidad = u.id_unidad 
       WHERE p.id_persona = ?`,
      [id]
    );

    await connection.commit();

    res.json({
      success: true,
      nombre_unidad: rows[0]?.nombre_unidad,
      foto_url: final_foto_url,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// --- RUTA PARA EL MAPA Y LA TABLA ---
// --- RUTA ACTUALIZADA PARA EL MAPA Y LA TABLA ---
app.get("/ocurrencias", async (req, res) => {
  try {
    const sql = `
            SELECT 
                o.id, 
                o.descripcion, 
                o.fecha, 
                o.latitud, 
                o.longitud, 
                o.lugar,
                m.nombre AS modalidad,
              
                CONCAT(p.nombres, ' ', p.apellido_paterno) AS registrado_por
            FROM ocurrencias o
            LEFT JOIN cat_modalidad m ON o.modalidad_id = m.id
            LEFT JOIN usuarios_sistema u ON o.usuario_id = u.id_usuario
            LEFT JOIN persona p ON u.id_persona = p.id_persona
           
            ORDER BY o.fecha DESC
        `;
    const [results] = await db.query(sql);
    res.json(results); // Aquí enviamos el Array de resultados
  } catch (err) {
    console.error("ERROR EN SQL:", err.message);
    // IMPORTANTE: Devolvemos un array vacío para que el frontend no explote
    res.status(500).json([]);
  }
});
// Ejemplo en tu API http://192.168.1.15:3000/poligonos-jv
app.get("/importar-geometria", async (req, res) => {
  try {
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync("./jv.json", "utf8"));

    await db.query("TRUNCATE TABLE jv_poligono_gis");

    for (const feature of data.features) {
      const nombre = feature.properties.name;
      const coords = feature.geometry.coordinates[0];

      // Creamos el texto WKT invirtiendo el orden: -12 primero, luego espacio, luego -77
      // Resultado esperado: "POLYGON((-12.07 -77.04, -12.08 -77.05...))"
      const wktPoints = coords.map((p) => `${p[1]} ${p[0]}`).join(",");
      const wkt = `POLYGON((${wktPoints}))`;

      // Insertamos usando ST_GeomFromText
      await db.query(
        "INSERT INTO jv_poligono_gis (nombre_cuadrante, area_poligono) VALUES (?, ST_GeomFromText(?))",
        [nombre, wkt],
      );
    }
    res.send("<h1>¡ORDEN FORZADO COMPLETADO!</h1>");
  } catch (error) {
    res.status(500).send(error.message);
  }
});
//aopp esto es para mostrar
app.get("/poligonos-jv", async (req, res) => {
  try {
    const [rows] = await db.query(`
            SELECT 
                nombre_cuadrante as nombre, 
                ST_AsGeoJSON(area_poligono, 6, 2) as geometria 
            FROM jv_poligono_gis
        `);

    const resultado = rows.map((fila) => {
      let geoFinal;

      // Si ya es un objeto, lo usamos directo. Si es string, lo parseamos.
      if (typeof fila.geometria === "object" && fila.geometria !== null) {
        geoFinal = fila.geometria;
      } else {
        try {
          geoFinal = JSON.parse(fila.geometria);
        } catch (e) {
          geoFinal = null; // O un polígono vacío por defecto
        }
      }

      return {
        nombre: fila.nombre,
        geometria: geoFinal,
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error("Error al obtener polígonos:", error);
    res.status(500).json({ error: error.message });
  }
});

//para importar http://localhost:3000/importar-geometria-pnp
app.get("/importar-geometria-pnp", async (req, res) => {
  try {
    const fs = require("fs");
    // Asegúrate de que este sea el JSON con los cuadrantes de la PNP
    const data = JSON.parse(fs.readFileSync("./cuadrantes.json", "utf8"));

    // Limpiamos la tabla PNP antes de cargar
    await db.query("TRUNCATE TABLE pnp_poligono_gis");

    for (const feature of data.features) {
      const nombre = feature.properties.name || "Sin nombre";
      const coords = feature.geometry.coordinates[0];

      // Inversión para Lima: Latitud (-12) primero para el WKT
      const wktPoints = coords.map((p) => `${p[1]} ${p[0]}`).join(",");
      const wkt = `POLYGON((${wktPoints}))`;

      await db.query(
        "INSERT INTO pnp_poligono_gis (nombre_cuadrante, area_poligono) VALUES (?, ST_GeomFromText(?))",
        [nombre, wkt],
      );
    }
    res.send("<h1>¡Datos de PNP cargados exitosamente!</h1>");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error en carga PNP: " + error.message);
  }
});

//mostrar pnmp  http://192.168.1.15:3000/poligonos-pnp
app.get("/poligonos-pnp", async (req, res) => {
  try {
    // Consultamos a la tabla pnp_poligono_gis
    const [rows] = await db.query(`
            SELECT 
                nombre_cuadrante as nombre, 
                ST_AsGeoJSON(area_poligono, 6, 2) as geometria 
            FROM pnp_poligono_gis
        `);

    const resultado = rows.map((fila) => {
      let geoFinal;

      // Validación de seguridad para el formato de geometría
      if (typeof fila.geometria === "object" && fila.geometria !== null) {
        geoFinal = fila.geometria;
      } else {
        try {
          geoFinal = JSON.parse(fila.geometria);
        } catch (e) {
          geoFinal = null;
        }
      }

      return {
        nombre: fila.nombre,
        geometria: geoFinal,
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error("Error al obtener polígonos PNP:", error);
    res.status(500).json({ error: error.message });
  }
});

//ESTO ES PARA VER UNIFICADO

// Caché en memoria RAM del servidor
let cachePoligonos = {
    jv: { data: null, timestamp: 0 },
    pnp: { data: null, timestamp: 0 }
};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutos (puedes ajustarlo)

app.get("/poligonos", async (req, res) => {
  const { tipo } = req.query;
  
  // Validar que el tipo sea estrictamente 'jv' o 'pnp'
  const tiposValidos = ["jv", "pnp"];
  if (!tipo || !tiposValidos.includes(tipo)) {
    return res.status(400).json({ 
      error: "Parámetro 'tipo' inválido o ausente. Los valores permitidos son: jv, pnp." 
    });
  }

  const ahora = Date.now();

  // 1. Verificar si tenemos los datos en caché y siguen vigentes
  if (cachePoligonos[tipo].data && (ahora - cachePoligonos[tipo].timestamp < CACHE_TTL)) {
    console.log(`[CACHÉ] Entregando polígonos '${tipo}' desde memoria RAM (Sin tocar MySQL)`);
    return res.json(cachePoligonos[tipo].data);
  }

  try {
    let query = "";

    if (tipo === "jv") {
      query = `SELECT nombre_cuadrante as nombre, ST_AsGeoJSON(ST_Simplify(area_poligono, 0.0001)) as geometria, 'jv' as fuente FROM jv_poligono_gis`;
    } else if (tipo === "pnp") {
      query = `SELECT nombre_cuadrante as nombre, ST_AsGeoJSON(ST_Simplify(area_poligono, 0.0001)) as geometria, 'pnp' as fuente FROM pnp_poligono_gis`;
    }

    const [rows] = await db.query(query);

    const resultado = rows.map((fila) => ({
      nombre: fila.nombre,
      fuente: fila.fuente,
      geometria:
        typeof fila.geometria === "string"
          ? JSON.parse(fila.geometria)
          : fila.geometria,
    }));

    // 2. Guardar el resultado procesado en la caché antes de responder
    cachePoligonos[tipo] = {
      data: resultado,
      timestamp: ahora
    };

    console.log(`[MYSQL] Consultando base de datos para polígonos '${tipo}'`);
    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- para listar---

// server.js
// En tu server.js

// LISTAR PROVINCIAS (Con el nombre del departamento)
app.get("/provincias", async (req, res) => {
  try {
    const sql = `
            SELECT p.*, d.nombre_departamento 
            FROM provincia p 
            INNER JOIN departamento d ON p.id_departamento = d.id_departamento 
            WHERE p.estado = 1 
            ORDER BY p.id_provincia DESC`;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LISTAR DEPARTAMENTOS (Para el Picker)
app.get("/departamentos", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id_departamento, nombre_departamento FROM departamento WHERE estado = 1",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INSERTAR PROVINCIA
app.post("/provincias", async (req, res) => {
  try {
    const { nombre_provincia, id_departamento } = req.body;
    const sql =
      "INSERT INTO provincia (nombre_provincia, id_departamento, estado) VALUES (?, ?, 1)";
    await db.query(sql, [nombre_provincia, id_departamento]);
    res.json({ success: true, message: "Provincia creada" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// INSERTAR O ACTUALIZAR PROVINCIA
app.post("/provincias", async (req, res) => {
  try {
    const { nombre_provincia, id_departamento, id_provincia } = req.body;
    const nombre = nombre_provincia.toUpperCase().trim();

    if (id_provincia) {
      // EDITAR
      await db.query(
        "UPDATE provincia SET nombre_provincia = ?, id_departamento = ? WHERE id_provincia = ?",
        [nombre, id_departamento, id_provincia],
      );
    } else {
      // NUEVO
      await db.query(
        "INSERT INTO provincia (nombre_provincia, id_departamento, estado) VALUES (?, ?, 1)",
        [nombre, id_departamento],
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DESACTIVAR PROVINCIA (Borrado Lógico)
app.patch("/provincias/:id/desactivar", async (req, res) => {
  try {
    await db.query("UPDATE provincia SET estado = 0 WHERE id_provincia = ?", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});
// --- CRUD DISTRITO CON JERARQUÍA Y MODALES ---
// LISTAR DISTRITOS (Con Provincia y Departamento)
app.get("/distritos", async (req, res) => {
  try {
    const sql = `
            SELECT d.*, p.nombre_provincia, dep.nombre_departamento, dep.id_departamento
            FROM distrito d
            INNER JOIN provincia p ON d.id_provincia = p.id_provincia
            INNER JOIN departamento dep ON p.id_departamento = dep.id_departamento
            WHERE d.estado = 1 
            ORDER BY d.id_distrito DESC`;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LISTAR PROVINCIAS POR DEPARTAMENTO (Para el filtro en cascada)
app.get("/provincias/filtro/:id_dep", async (req, res) => {
  try {
    const { id_dep } = req.params;
    const [rows] = await db.query(
      "SELECT id_provincia, nombre_provincia FROM provincia WHERE id_departamento = ? AND estado = 1",
      [id_dep],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INSERTAR DISTRITO
app.post("/distritos", async (req, res) => {
  try {
    const { nombre_distrito, id_provincia } = req.body;
    const sql =
      "INSERT INTO distrito (nombre_distrito, id_provincia, estado) VALUES (?, ?, 1)";
    await db.query(sql, [nombre_distrito, id_provincia]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// EDITAR DISTRITO
app.put("/distritos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_distrito, id_provincia } = req.body;
    const sql =
      "UPDATE distrito SET nombre_distrito = ?, id_provincia = ? WHERE id_distrito = ?";
    await db.query(sql, [nombre_distrito.toUpperCase(), id_provincia, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// BORRADO LÓGICO (DESACTIVAR)
app.patch("/distritos/:id/desactivar", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("UPDATE distrito SET estado = 0 WHERE id_distrito = ?", [
      id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});
// --- CRUD DEPARTAMENTO ---

// A. Listar departamentos activos
app.get("/departamentos", async (req, res) => {
  try {
    const sql =
      "SELECT id_departamento, nombre_departamento FROM departamento WHERE estado = 1 ORDER BY nombre_departamento ASC";
    const [results] = await db.query(sql);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener departamentos" });
  }
});

// B. Insertar Departamento con VALIDACIÓN de duplicados
app.post("/departamentos", async (req, res) => {
  try {
    const { nombre_departamento } = req.body;

    if (!nombre_departamento) {
      return res
        .status(400)
        .json({ success: false, message: "El nombre es obligatorio" });
    }

    // 1. Validar si ya existe (sin importar mayúsculas/minúsculas)
    const [existentes] = await db.query(
      "SELECT id_departamento FROM departamento WHERE nombre_departamento = ? AND estado = 1",
      [nombre_departamento.trim().toUpperCase()],
    );

    if (existentes.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Este departamento ya existe en la base de datos.",
      });
    }

    // 2. Insertar si no es duplicado
    const sql =
      "INSERT INTO departamento (nombre_departamento, estado) VALUES (?, 1)";
    const [result] = await db.query(sql, [
      nombre_departamento.trim().toUpperCase(),
    ]);

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// C. Actualizar Departamento
app.put("/departamentos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_departamento } = req.body;

    // Validar que el nuevo nombre no lo tenga otro registro
    const [duplicado] = await db.query(
      "SELECT id_departamento FROM departamento WHERE nombre_departamento = ? AND id_departamento != ? AND estado = 1",
      [nombre_departamento, id],
    );

    if (duplicado.length > 0) {
      return res.status(400).json({
        success: false,
        message: "El nombre ya está en uso por otro departamento.",
      });
    }

    const sql =
      "UPDATE departamento SET nombre_departamento = ? WHERE id_departamento = ?";
    await db.query(sql, [nombre_departamento.toUpperCase(), id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// D. Borrado Lógico (Cambiar estado)
app.delete("/departamentos/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // OPCIONAL: Validar si tiene provincias asociadas antes de "eliminar"
    const [provincias] = await db.query(
      "SELECT id_provincia FROM provincia WHERE id_departamento = ? AND estado = 1",
      [id],
    );
    if (provincias.length > 0) {
      return res.status(400).json({
        success: false,
        message: "No se puede desactivar: tiene provincias asociadas.",
      });
    }

    const sql = "UPDATE departamento SET estado = 0 WHERE id_departamento = ?";
    await db.query(sql, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// --- RUTA 1: LISTAR TODAS LAS VÍAS (Con JOIN a tipos y distritos) ---
app.get("/vias", async (req, res) => {
  try {
    const sql = `
            SELECT 
                v.id_via, 
                v.nombre_via, 
                v.id_tipo_via, 
                v.id_distrito, 
                t.abreviatura,  -- Campo real en tu SQL
                t.descripcion,  -- Campo real en tu SQL
                d.nombre_distrito
            FROM via v
            INNER JOIN tipo_via t ON v.id_tipo_via = t.id_tipo_via
            INNER JOIN distrito d ON v.id_distrito = d.id_distrito
            WHERE v.estado = 1
            ORDER BY v.id_via DESC
        `;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Error en GET /vias:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- RUTA 2: LISTAR TIPOS DE VÍA (Para el Picker) ---
app.get("/tipos-via", async (req, res) => {
  try {
    // Seleccionamos abreviatura y descripcion según tu tabla
    const sql =
      "SELECT id_tipo_via, abreviatura, descripcion FROM tipo_via WHERE estado = 1";
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Error en GET /tipos-via:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- RUTA 3: LISTAR DISTRITOS (Para el Picker) ---
app.get("/distritos/todos", async (req, res) => {
  try {
    const sql =
      "SELECT id_distrito, nombre_distrito FROM distrito WHERE estado = 1 ORDER BY nombre_distrito ASC";
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUTA 4: CREAR NUEVA VÍA ---
app.post("/vias", async (req, res) => {
  try {
    const { nombre_via, id_tipo_via, id_distrito } = req.body;
    const sql =
      "INSERT INTO via (id_tipo_via, nombre_via, id_distrito, estado) VALUES (?, ?, ?, 1)";
    const [result] = await db.query(sql, [
      id_tipo_via,
      nombre_via.toUpperCase(),
      id_distrito,
    ]);
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- RUTA 5: ACTUALIZAR VÍA EXISTENTE ---
app.put("/vias/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_via, id_tipo_via, id_distrito } = req.body;
    const sql =
      "UPDATE via SET id_tipo_via = ?, nombre_via = ?, id_distrito = ? WHERE id_via = ?";
    await db.query(sql, [
      id_tipo_via,
      nombre_via.toUpperCase(),
      id_distrito,
      id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- RUTA 6: DESACTIVAR VÍA (Borrado Lógico) ---
app.patch("/vias/:id/desactivar", async (req, res) => {
  try {
    const { id } = req.params;
    const sql = "UPDATE via SET estado = 0 WHERE id_via = ?";
    await db.query(sql, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 1. LISTADOS PARA LOS PICKERS (TODOS)
// ==========================================
// Esto evita que el server se caiga si una tabla no existe
const consultarTabla = async (sql, res) => {
  try {
    const [rows] = await db.query(sql);
    res.json(rows || []);
  } catch (err) {
    console.error("Error en query:", sql, err.message);
    res
      .status(500)
      .json({ error: "Error en la base de datos", detalle: err.message });
  }
};

// --- LISTADO DE PICKERS ---
app.get("/vias", (req, res) => {
  consultarTabla(
    "SELECT id_via, nombre_via FROM via WHERE estado = 1 ORDER BY nombre_via ASC",
    res,
  );
});

app.get("/cuadras", (req, res) => {
  consultarTabla(
    "SELECT id_cuadra, numero_cuadra FROM cuadra ORDER BY numero_cuadra ASC",
    res,
  );
});

app.get("/jv-cuadrantes", (req, res) => {
  consultarTabla(
    "SELECT id_jv_cuadrante, nombre_cuadrante FROM jv_cuadrante ORDER BY nombre_cuadrante ASC",
    res,
  );
});

// Ruta para Sector PNP (Asegúrate que la tabla sea pnp_cuadrante)
app.get("/pnp-cuadrantes", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id_pnp_cuadrante, codigo_cuadrante FROM pnp_cuadrante ORDER BY codigo_cuadrante ASC",
    );
    res.json(rows);
  } catch (err) {
    console.error("Error en PNP:", err.message);
    res.status(500).json({ error: "Fallo en tabla pnp_cuadrante" });
  }
});

app.get("/tipos-lugar", async (req, res) => {
  try {
    // Filtramos por estado = 1 para que el Picker solo jale los activos
    const [rows] = await db.query(
      "SELECT id_tipo, nombre_tipo FROM tipos_lugar WHERE estado = 1 ORDER BY nombre_tipo ASC",
    );
    res.json(rows);
  } catch (err) {
    console.error("Error en Tipo Lugar:", err.message);
    res.status(500).json({ error: "Fallo al obtener tipos" });
  }
});
// ==========================================
// 2. CRUD DE LUGARES (CON TODOS LOS FK)
// ==========================================
// Listar Lugares con nombres de fecha_eventos
// Listar lugares activos
app.post("/lugares", async (req, res) => {
  // 1. Recibimos los datos del celular
  const {
    nombre_lugar,
    direccion,
    id_via,
    id_cuadra,
    id_tipo_lugar,
    id_jv_cuadrante,
    id_pnp_cuadrante,
    latitud,
    longitud,
  } = req.body;

  console.log("Datos recibidos para insertar:", req.body);

  try {
    // 2. Creamos el punto WKT para la columna posicion_gps (Obligatorio)
    // Usamos lat/lon o 0,0 si vienen vacíos
    const lat = latitud || 0;
    const lon = longitud || 0;
    const puntoWKT = `POINT(${lat} ${lon})`;

    // 3. SQL: Insertamos en las columnas base.
    // El trigger se encargará de las que terminan en _asig.
    const sql = `INSERT INTO lugar 
            (nombre_lugar, direccion, id_via, id_cuadra, id_tipo_lugar, 
             id_pnp_cuadrante, id_jv_cuadrante, 
             latitud, longitud, posicion_gps) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?))`;

    const [result] = await db.query(sql, [
      nombre_lugar ? nombre_lugar.toUpperCase() : "SIN NOMBRE",
      direccion || "SIN DIRECCIÓN",
      id_via || null,
      id_cuadra || null,
      id_tipo_lugar || null,
      id_pnp_cuadrante || null,
      id_jv_cuadrante || null,
      latitud || null,
      longitud || null,
      puntoWKT,
    ]);

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("ERROR SQL AL GUARDAR:", err.sqlMessage);
    res.status(500).json({
      error: err.sqlMessage || "Error al insertar en la base de datos",
    });
  }
});
app.get("/lugares", async (req, res) => {
  try {
    // Consultamos solo la tabla lugar para evitar el error de "Table doesn't exist"
    const sql = `SELECT id_lugar, nombre_lugar, direccion, id_via, id_tipo_lugar, estado FROM lugar ORDER BY id_lugar DESC`;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Error SQL:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// RUTA PARA EL SLICER (Switch)
app.patch("/lugares/:id/estado", async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  try {
    await db.query("UPDATE lugar SET estado = ? WHERE id_lugar = ?", [
      estado,
      id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//WHERE L.estado = 1 AGREGAR ANTES DE AND
app.get("/lugares-giss", async (req, res) => {
  try {
    const sql = `
            SELECT 
                L.id_lugar, 
                L.nombre_lugar, 
                V.nombre_via, 
                L.latitud, 
                L.longitud,
                T.nombre_tipo as tipo,
                P.codigo_cuadrante as nom_pnp, 
                J.nombre_cuadrante as nom_jv
            FROM lugar L
            LEFT JOIN via V ON L.id_via = V.id_via
            LEFT JOIN tipos_lugar T ON L.id_tipo_lugar = T.id_tipo
            LEFT JOIN pnp_cuadrante P ON L.id_pnp_cuadrante = P.id_pnp_cuadrante
            LEFT JOIN jv_cuadrante J ON L.id_jv_cuadrante = J.id_jv_cuadrante
        WHERE L.id_tipo_lugar != 4;
        `;
    const [rows] = await db.query(sql);

    const resultado = rows.map((f) => ({
      id: f.id_lugar,
      nombre: f.nombre_lugar,
      direccion: f.nombre_via || "",
      tipo: f.tipo || "GENERAL",
      pnp: f.nom_pnp || "N/A", // Para filtrar en el TSX
      jv: f.nom_jv || "N/A", // Para filtrar en el TSX
      coords: [parseFloat(f.latitud), parseFloat(f.longitud)], // Tu formato preferido
    }));

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- RUTA CONSOLIDADA PARA REPORTES DINÁMICOS ---
app.post("/reportar", async (req, res) => {
  const {
    id_usuario,
    id_modalidad,
    grupo,
    id_origen,
    descripcion,
    hora_alerta,
    hora_llegada,
    hora_repliegue,
    latitud,
    longitud,
    camaras,
    id_tipo_vehiculo,
    placa_agresor,
  } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Insertar en ocurrencia_registro (con el ENUM 'grupo' y los 3 TIME)
    const [resReg] = await conn.execute(
      `INSERT INTO ocurrencia_registro 
            (id_usuario, id_modalidad, grupo, id_origen, descripcion, hora_alerta, hora_llegada, hora_repliegue, latitud, longitud, fecha_registro) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id_usuario,
        id_modalidad,
        grupo,
        id_origen,
        descripcion,
        hora_alerta,
        hora_llegada,
        hora_repliegue,
        latitud,
        longitud,
      ],
    );

    const lastId = resReg.insertId;

    // 2. Detalle si es Cámaras
    if (id_origen === 1 && camaras) {
      for (let id_cam of camaras) {
        await conn.execute(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES (?, ?)",
          [lastId, id_cam],
        );
      }
    }

    // 3. Detalle si es Patrullaje
    if (id_origen === 2) {
      await conn.execute(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, id_tipo_vehiculo, placa_agresor) VALUES (?, ?, ?)",
        [lastId, id_tipo_vehiculo, placa_agresor],
      );
    }

    await conn.commit();
    res.json({ success: true, message: "Ocurrencia y tiempos registrados" });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

//para ocurrencias_registro 1.
app.get("/catalogos/completos", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // Ejecutar consultas en paralelo
    const [
      modalidades, // cat_modalidad
      usuarios, // usuarios_sistema + persona
      lugares, // lugar
      origenes, // origen
    ] = await Promise.all([
      connection.query(
        "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
      ),
      connection.query(`
                SELECT 
                    u.id_usuario AS value, 
                    CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', COALESCE(p.apellido_materno, '')) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),
      connection.query(
        "SELECT id_lugar AS value, nombre_lugar AS label FROM lugar ORDER BY nombre_lugar",
      ),
      connection.query(
        "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
      ),
    ]);

    res.json({
      usuarios: usuarios[0],
      lugares: lugares[0],
      modalidades: modalidades[0],
      origenes: origenes[0],
    });
  } catch (error) {
    console.error("Error catálogos:", error);
    res.status(500).json({ error: "Error cargando catálogos" });
  } finally {
    if (connection) connection.release();
  }
});
app.post("/ocurrencias/registrar", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
    } = req.body;

    const limpiarId = (val) => {
      const num = parseInt(val);
      return isNaN(num) || num <= 0 ? null : num;
    };

    const v_usuario = limpiarId(id_usuario);
    const v_lugar = limpiarId(id_lugar);
    const v_modalidad = limpiarId(id_modalidad);
    const v_origen = limpiarId(id_origen);

    // VALIDACIONES BÁSICAS
    if (!v_usuario) throw new Error("ID de usuario requerido.");
    if (!v_lugar) throw new Error("Lugar/sector requerido.");
    if (!v_modalidad) throw new Error("Modalidad requerida.");
    if (!grupo || !["1", "2", "3", "4"].includes(grupo))
      throw new Error("Grupo inválido (1-4).");
    if (!descripcion?.trim()) throw new Error("Descripción requerida.");

    // SQL DE INSERCIÓN SIN id_tipo_ocurrencia
    const sql = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, 
            hora_repliegue, id_lugar, id_usuario, id_modalidad, 
            latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo, id_origen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?, ?)`;

    const [result] = await connection.query(sql, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      v_lugar,
      v_usuario,
      v_modalidad,
      parseFloat(latitud_gps) || null,
      parseFloat(longitud_gps) || null,
      nombre_punto_gps || null,
      referencia || null,
      unidad_encargada || "SERENAZGO",
      fecha_evento || null,
      grupo,
      v_origen,
    ]);

    const id_nueva = result.insertId;

    // PROCESAMIENTO DE FOTOS
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) =>
          cloudinary.uploader.upload(f.base64_data, {
            folder: "serenazgo/ocurrencias",
            resource_type: "auto",
          }),
        );

      const uploadResults = await Promise.all(uploadPromises);
      const photoValues = uploadResults.map((r) => [
        id_nueva,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: "Ocurrencia registrada exitosamente",
      id: id_nueva,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("ERROR EN REGISTRO:", error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// para camara verificado
app.get("/catalogos/completo/cam", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const [modalidadesRes, usuariosRes, lugaresRes, origenesRes, camarasRes] =
      await Promise.all([
        // Modalidades
        connection.query(
          "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
        ),

        // Usuarios (Concatenados)
        connection.query(`
                SELECT 
                    u.id_usuario AS value, 
                    CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),

        // Lugares
        connection.query(
          "SELECT id_lugar AS value, nombre_lugar AS label FROM lugar ORDER BY nombre_lugar",
        ),

        // Orígenes
        connection.query(
          "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
        ),

        // CÁMARAS: Aquí incluimos el código en el label usando CONCAT
        connection.query(`
                SELECT 
                    id_camara AS value, 
                    CONCAT(codigo_camara, ' - ', nombre_camara) AS label 
                FROM camara 
                ORDER BY codigo_camara ASC
            `),
      ]);

    res.json({
      usuarios: usuariosRes[0],
      lugares: lugaresRes[0],
      modalidades: modalidadesRes[0],
      origenes: origenesRes[0],
      camara: camarasRes[0],
    });
  } catch (error) {
    console.error("Error catálogos:", error);
    res.status(500).json({ error: "Error cargando catálogos" });
  } finally {
    if (connection) connection.release();
  }
});
app.post("/ocurrencias/registrar/cam", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
    } = req.body;

    // 1. INSERTAR OCURRENCIA (Incluyendo GPS para evitar el error de default value)
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      latitud_gps || 0, // GPS captado del celular
      longitud_gps || 0, // GPS captado del celular
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR EN detalle_camara (Vínculo con la tabla camara)
    if (id_camara) {
      // 1. Convertimos el string '7,9,20' en un array real [7, 9, 20]
      const idsCamaras = id_camara.split(",").map((id) => id.trim());

      // 2. Definimos la consulta
      const sqlDetalleCamara =
        "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES (?, ?)";

      // 3. Ejecutamos un insert por cada cámara usando un bucle for...of
      // Esto asegura que cada cámara se guarde como un número individual
      for (const id of idsCamaras) {
        if (id) {
          // Verificamos que el ID no esté vacío
          await connection.query(sqlDetalleCamara, [id_nueva_ocurrencia, id]);
        }
      }
    }

    // 3. PROCESAR FOTOS (Subida a Cloudinary)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) =>
          cloudinary.uploader.upload(f.base64_data, {
            folder: "serenazgo/ocurrencias",
            resource_type: "auto",
          }),
        );

      const uploadResults = await Promise.all(uploadPromises);

      const photoValues = uploadResults.map((r) => [
        id_nueva_ocurrencia,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("ERROR:", error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// para camara verificado 1
app.get("/catalogos/completo/camn", async (req, res) => {
  let connection;
  const tipoLugar = req.query.tipoLugar || 5;
  try {
    connection = await db.getConnection();

    const [
      modalidadesRes,
      usuariosRes,
      lugaresRes,
      origenesRes,
      camarasRes,
      tiposPatrullajeRes, // Resultado para tipo_patrullaje
      modPatrullajeRes, // Resultado para modalidad_patrullaje
    ] = await Promise.all([
      // 1. Modalidades de Ocurrencia
      connection.query(
        "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
      ),

      // 2. Usuarios
      connection.query(`
                SELECT 
                    u.id_usuario AS value, 
                    CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),

      // 3. Lugares
      connection.query(
        `
                SELECT 
                    l.id_lugar AS value, 
                    CONCAT(tv.abreviatura, ' ', v.nombre_via, ' CDRA. ', c.numero_cuadra) AS label 
                FROM lugar l
                INNER JOIN cuadra c ON l.id_cuadra = c.id_cuadra
                INNER JOIN via v ON l.id_via = v.id_via
                INNER JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
                WHERE l.id_tipo_lugar = ?
                ORDER BY v.nombre_via ASC, c.numero_cuadra ASC
            `,
        [tipoLugar],
      ),
      // 4. Orígenes
      connection.query(
        "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
      ),

      // 5. Cámaras
      connection.query(`
                SELECT 
                    id_camara AS value, 
                    CONCAT(codigo_camara, ' - ', nombre_camara) AS label 
                FROM camara 
                ORDER BY codigo_camara ASC
            `),

      // 6. NUEVO: Catálogo de Tipo de Patrullaje
      connection.query(
        "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje ORDER BY nombre",
      ),

      // 7. NUEVO: Catálogo de Modalidad de Patrullaje
      connection.query(
        "SELECT id_modalidadp AS value, nombre AS label FROM modalidad_patrullaje ORDER BY nombre",
      ),
    ]);

    // Enviamos todo consolidado al frontend
    res.json({
      usuarios: usuariosRes[0],
      lugares: lugaresRes[0],
      modalidades: modalidadesRes[0],
      origenes: origenesRes[0],
      camara: camarasRes[0],
      tipos_patrullaje: tiposPatrullajeRes[0],
      modalidades_patrullaje: modPatrullajeRes[0],
    });
  } catch (error) {
    console.error("Error al cargar catálogos:", error);
    res.status(500).json({ error: "Error cargando catálogos" });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/ocurrencias/registrar/camn", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp, // NUEVOS CAMPOS
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
    } = req.body;

    // 1. INSERTAR OCURRENCIA (Actualizado con los nuevos campos de patrullaje)
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, 
            latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null, // NUEVO
      id_modalidadp || null, // NUEVO
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR EN detalle_camara_ocurrencia
    if (id_camara) {
      // Si el frontend envía un string como '7,9,20'
      const idsCamaras =
        typeof id_camara === "string"
          ? id_camara.split(",").map((id) => id.trim())
          : [id_camara];

      const sqlDetalleCamara =
        "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES (?, ?)";

      for (const id of idsCamaras) {
        if (id) {
          await connection.query(sqlDetalleCamara, [id_nueva_ocurrencia, id]);
        }
      }
    }

    // 3. PROCESAR FOTOS (Cloudinary)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) =>
          cloudinary.uploader.upload(f.base64_data, {
            folder: "serenazgo/ocurrencias",
            resource_type: "auto",
          }),
        );

      const uploadResults = await Promise.all(uploadPromises);

      const photoValues = uploadResults.map((r) => [
        id_nueva_ocurrencia,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("ERROR REGISTRO:", error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

//cascada
// --- 1. ENDPOINT CONSOLIDADO (Ajustado para no cargar todos los lugares de golpe) ---
app.get("/catalogos/completo/camna", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const [
      modalidadesRes,
      usuariosRes,
      origenesRes,
      camarasRes,
      tiposPatrullajeRes,
      modPatrullajeRes,
      tiposViaRes, // Agregamos tipos de vía aquí para la carga inicial
    ] = await Promise.all([
      connection.query(
        "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
      ),
      connection.query(`
                SELECT u.id_usuario AS value, 
                CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),
      connection.query(
        "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
      ),
      connection.query(
        'SELECT id_camara AS value, CONCAT(codigo_camara, " - ", nombre_camara) AS label FROM camara ORDER BY codigo_camara ASC',
      ),
      connection.query(
        "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje ORDER BY nombre",
      ),
      connection.query(
        "SELECT id_modalidadp AS value, nombre AS label FROM modalidad_patrullaje ORDER BY nombre",
      ),
      connection.query(
        "SELECT id_tipo_via AS value, abreviatura AS label FROM tipo_via ORDER BY abreviatura ASC",
      ),
    ]);

    res.json({
      usuarios: usuariosRes[0],
      modalidades: modalidadesRes[0],
      origenes: origenesRes[0],
      camara: camarasRes[0],
      tipos_patrullaje: tiposPatrullajeRes[0],
      modalidades_patrullaje: modPatrullajeRes[0],
      tipos_via: tiposViaRes[0], // Esto cargará el primer Picker
    });
  } catch (error) {
    console.error("Error al cargar catálogos:", error);
    res.status(500).json({ error: "Error cargando catálogos" });
  } finally {
    if (connection) connection.release();
  }
});

// --- 2. ENDPOINT PARA VÍAS (Depende de Tipo de Vía) ---
app.get("/catalogos/vias/:idTipoVia", async (req, res) => {
  let connection;
  try {
    const { idTipoVia } = req.params;

    // Si envían el id 11, devolvemos un arreglo vacío inmediatamente
    if (Number(idTipoVia) === 11) {
      return res.json([]);
    }

    connection = await db.getConnection();
    const [rows] = await connection.query(
      "SELECT id_via AS value, nombre_via AS label FROM via WHERE id_tipo_via = ? ORDER BY nombre_via ASC",
      [idTipoVia],
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// --- 3. ENDPOINT PARA CUADRAS (Depende de Vía - Retorna id_lugar) ---
app.get("/catalogos/cuadras/:idVia", async (req, res) => {
  let connection;
  try {
    const { idVia } = req.params;
    // Si envían tipoLugar por query param lo usa, si no, busca todos los registros asociados a la vía
    const { tipoLugar } = req.query; 

    connection = await db.getConnection();

    let sql = `
      SELECT 
        l.id_lugar AS value, 
        CONCAT('CDRA. ', c.numero_cuadra) AS label 
      FROM lugar l
      INNER JOIN cuadra c ON l.id_cuadra = c.id_cuadra
      WHERE l.id_via = ?
    `;

    const params = [idVia];

    // Solo filtra por tipoLugar si te lo envían explícitamente en la URL
    if (tipoLugar) {
      sql += ` AND l.id_tipo_lugar = ?`;
      params.push(tipoLugar);
    }

    sql += ` ORDER BY CAST(c.numero_cuadra AS UNSIGNED) ASC`;

    const [rows] = await connection.query(sql, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// --- FIN DE CASCADA ---
app.post("/ocurrencias/registrar/modalidad", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
    } = req.body;

    // 1. INSERTAR OCURRENCIA
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, 
            latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen, // Enviará 1 por defecto desde el front
      id_tipop || 1,
      id_modalidadp || 1,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. PROCESAR FOTOS (Cloudinary)
    // Se mantiene igual para que las evidencias se guarden correctamente
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) =>
          cloudinary.uploader.upload(f.base64_data, {
            folder: "serenazgo/ocurrencias",
            resource_type: "auto",
          }),
        );

      const uploadResults = await Promise.all(uploadPromises);

      const photoValues = uploadResults.map((r) => [
        id_nueva_ocurrencia,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("ERROR REGISTRO:", error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

//obtener vehiculos
// 1. Obtener tipos de vehículo (para el primer dropdown)
app.get("/catalogos/tipos-vehiculo", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id_tipo_vehiculo as value, descripcion as label FROM tipo_vehiculo",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// para jalar radios

app.get("/catalogos/radios", async (req, res) => {
  try {
    // Seleccionamos el id como 'value' y el campo a mostrar como 'label'
    const [rows] = await db.query(
      "SELECT id_radio as value, issi_dolphin as label FROM radio",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//para jalar zona

app.get("/catalogos/zonas", async (req, res) => {
  try {
    // Mapeamos el ID a 'value' y la descripción a 'label'
    const [rows] = await db.query(
      "SELECT id_zona as value, descripcion as label FROM zona",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Obtener vehículos por tipo que estén ACTIVOS
app.get("/catalogos/vehiculos-por-tipo/:idTipo", async (req, res) => {
  try {
    const { idTipo } = req.params;
    const query = `
            SELECT 
                numero_unidad,
                id_unidad as value, 
                CONCAT(placa, ' (N° ', numero_unidad, ')') as label 
            FROM sipcop_flota_municipal 
            WHERE id_tipo_vehiculo = ? 
            AND estado = 1
        `;

    const [rows] = await db.query(query, [idTipo]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener la flota activa" });
  }
});

app.post("/ocurrencias/registrar/veh", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_tipop,
      id_modalidadp,
      vehiculos_detalle,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
    } = req.body;

    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, 
            latitud_gps, longitud_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen || 3,
      id_tipop || 1,
      id_modalidadp || 1,
      latitud_gps || 0,
      longitud_gps || 0,
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocu = resOcurrencia.insertId;

    if (id_tipop === 3 && vehiculos_detalle?.length > 0) {
      const values = vehiculos_detalle.map((v) => [
        id_nueva_ocu,
        v.id_tipo_vehiculo,
        v.id_unidad,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad) VALUES ?`,
        [values],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocu });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.get("/catalogos/pnp-activos", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id_pnp as value, CONCAT(grado, ' ', nombres, ' ', apellidos) as label FROM cat_pnp WHERE estado = 1",
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/ocurrencias/registrar/vehiv", async (req, res) => {
  let connection;
  let uploadedPublicIds = [];

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_tipop,
      id_modalidadp,
      vehiculos_detalle,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
    } = req.body;

    // 1. INSERTAR CABECERA
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, 
            latitud_gps, longitud_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad || 126,
      id_origen || 3,
      id_tipop || 1,
      id_modalidadp || 1,
      latitud_gps || "0",
      longitud_gps || "0",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo || "1",
    ]);

    const id_nueva_ocu = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE VEHÍCULOS (Igual que antes)
    if (
      vehiculos_detalle &&
      Array.isArray(vehiculos_detalle) &&
      vehiculos_detalle.length > 0
    ) {
      const values = vehiculos_detalle.map((v) => [
        id_nueva_ocu,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion || "MUNICIPAL",
        v.id_pnp || null,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [values],
      );
    }

    // 3. PROCESAR FOTOS CON OPTIMIZACIÓN MÁXIMA (GRATIS)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) => {
          const fileStr = f.base64_data.startsWith("data:")
            ? f.base64_data
            : `data:image/jpeg;base64,${f.base64_data}`;

          return cloudinary.uploader.upload(fileStr, {
            folder: "serenazgo/ocurrencias",
            resource_type: "auto",
            // --- CAMBIOS PARA NO PAGAR ---
            transformation: [
              { width: 1080, crop: "limit" }, // Evita fotos gigantes
              { quality: "auto" }, // Compresión inteligente
              { fetch_format: "auto" }, // Formato WebP/ligero automático
            ],
          });
        });

      const uploadResults = await Promise.all(uploadPromises);
      uploadedPublicIds = uploadResults.map((r) => r.public_id);

      const photoValues = uploadResults.map((r) => [
        id_nueva_ocu,
        r.secure_url, // Esta URL ya vendrá optimizada por la transformación anterior
        r.public_id,
      ]);

      await connection.query(
        `INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?`,
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocu });
  } catch (error) {
    if (connection) await connection.rollback();
    if (uploadedPublicIds.length > 0) {
      await cloudinary.api.delete_resources(uploadedPublicIds);
    }
    console.error("ERROR EN REGISTRO:", error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.get("/ocurrencias/listar/modvehi", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // Parámetros de paginación
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // Tu consulta SQL exacta
    const sql = `
           SELECT 
    o.id_ocurrencia,
    o.fecha_reporte,
     o.codigo_seguimiento,
    o.fecha_evento,
      o.hora_llegada,
    o.descripcion,
    o.unidad_encargada,
     o.referencia,
    -- Información de la Persona (Usuario que registra)
    p.documento_numero AS persona_dni,
    CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,

    -- Nombres de catálogos
    m.nombre AS modalidad_nombre,
    v.nombre_via AS via_nombre,
    c.numero_cuadra AS cuadra,
    tp.nombre AS tipo_patrullaje_nombre,
    mp.nombre AS mod_patrullaje_nombre,

    -- Ubicación formateada
    l.id_lugar AS value, 
    CONCAT(tv.abreviatura, ' ', v.nombre_via, ' CDRA. ', c.numero_cuadra) AS label,
    
    -- Subconsultas para fotos
    (SELECT COUNT(*) FROM foto_ocurrencia_registro f 
     WHERE f.id_ocurrencia = o.id_ocurrencia) as total_fotos,
    
    (SELECT url_imagen FROM foto_ocurrencia_registro f 
     WHERE f.id_ocurrencia = o.id_ocurrencia LIMIT 1) as foto_principal

FROM ocurrencia_registro o
-- Relación con Persona
LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario -- Ajustar según el campo de relación en o
LEFT JOIN persona p ON us.id_persona = p.id_persona
-- Otros Joins existentes
LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
LEFT JOIN via v ON l.id_via = v.id_via
LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp

ORDER BY o.fecha_reporte DESC
LIMIT ? OFFSET ?; 
        `;

    const [rows] = await connection.query(sql, [limit, offset]);

    // Formateo para el componente TSX
    const respuesta = rows.map((item) => ({
      ...item,
      fecha_evento: item.fecha_evento
        ? new Date(item.fecha_evento).toISOString().split("T")[0]
        : "S/F",
      tiene_fotos: item.total_fotos > 0,
      // Convertimos la foto única en un array para que el componente no falle
      fotos: item.foto_principal ? [item.foto_principal] : [],
    }));

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/ocurrencias/registrar/modvehib", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
    } = req.body;

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, 
            latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS (Lógica exitosa integrada)
    if (id_camara) {
      // Normalizar: convertir a array de strings limpios
      const idsCamaras =
        typeof id_camara === "string"
          ? id_camara.split(",").map((id) => id.trim())
          : Array.isArray(id_camara)
            ? id_camara
            : [id_camara];

      const sqlDetalleCamara =
        "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES (?, ?)";

      for (const id of idsCamaras) {
        // Solo inserta si el ID no está vacío y es un número válido
        if (id && !isNaN(parseInt(id))) {
          await connection.query(sqlDetalleCamara, [id_nueva_ocurrencia, id]);
        }
      }
      console.log(
        `✅ Detalle de cámaras vinculado para Ocurrencia ID: ${id_nueva_ocurrencia}`,
      );
    }

    // 3. PROCESAR FOTOS (Cloudinary)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) =>
          cloudinary.uploader.upload(f.base64_data, {
            folder: "serenazgo/ocurrencias",
            resource_type: "auto",
          }),
        );

      const uploadResults = await Promise.all(uploadPromises);
      const photoValues = uploadResults.map((r) => [
        id_nueva_ocurrencia,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR EN REGISTRO:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.post("/ocurrencias/registrar/modvehirender", async (req, res) => {
  let connection;
  let uploadedPublicIds = []; // Control de limpieza

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      vehiculos_detalle,
    } = req.body;

    // 1. INSERTAR CABECERA DE OCURRENCIA
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, 
            latitud_gps, longitud_gps, nombre_punto_gps, referencia, 
            unidad_encargada, fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || 1,
      id_modalidadp || 1,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE VEHÍCULOS
    if (
      vehiculos_detalle &&
      Array.isArray(vehiculos_detalle) &&
      vehiculos_detalle.length > 0
    ) {
      const values = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion || "MUNICIPAL",
        v.id_pnp || null,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [values],
      );
    }

    // 3. PROCESAR FOTOS USANDO EL UPLOAD PRESET (RENDERIZADO AUTOMÁTICO)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) => {
          const fileStr = f.base64_data.startsWith("data:")
            ? f.base64_data
            : `data:image/jpeg;base64,${f.base64_data}`;

          // Usamos el preset 'sasas' que configuraste con c_scale,w_1000/q_60
          return cloudinary.uploader.upload(fileStr, {
            upload_preset: "renderizado",
          });
        });

      const uploadResults = await Promise.all(uploadPromises);
      uploadedPublicIds = uploadResults.map((r) => r.public_id);

      const photoValues = uploadResults.map((r) => [
        id_nueva_ocurrencia,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();

    // LIMPIEZA: Si la base de datos falla, borramos de Cloudinary para no desperdiciar créditos
    if (uploadedPublicIds.length > 0) {
      await cloudinary.api.delete_resources(uploadedPublicIds);
    }

    console.error("ERROR REGISTRO:", error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// GET: Listar todas las ocurrencias con sus nombres de catálogo
app.get("/ocurrencias/listar/modvehis", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // Parámetros de paginación
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // Tu consulta SQL exacta
    const sql = `
           SELECT 
    o.id_ocurrencia,
    o.fecha_reporte,
     o.codigo_seguimiento,
    o.fecha_evento,
      o.hora_llegada,
    o.descripcion,
    o.unidad_encargada,
     o.referencia,
    -- Información de la Persona (Usuario que registra)
    p.documento_numero AS persona_dni,
    CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,

    -- Nombres de catálogos
    m.nombre AS modalidad_nombre,
    v.nombre_via AS via_nombre,
    c.numero_cuadra AS cuadra,
    tp.nombre AS tipo_patrullaje_nombre,
    mp.nombre AS mod_patrullaje_nombre,

    -- Ubicación formateada
    l.id_lugar AS value, 
    CONCAT(tv.abreviatura, ' ', v.nombre_via, ' CDRA. ', c.numero_cuadra) AS label,
    
    -- Subconsultas para fotos
    (SELECT COUNT(*) FROM foto_ocurrencia_registro f 
     WHERE f.id_ocurrencia = o.id_ocurrencia) as total_fotos,
    
    (SELECT url_imagen FROM foto_ocurrencia_registro f 
     WHERE f.id_ocurrencia = o.id_ocurrencia LIMIT 1) as foto_principal

FROM ocurrencia_registro o
-- Relación con Persona
LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario -- Ajustar según el campo de relación en o
LEFT JOIN persona p ON us.id_persona = p.id_persona
-- Otros Joins existentes
LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
LEFT JOIN via v ON l.id_via = v.id_via
LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp

ORDER BY o.fecha_reporte DESC;
        `;

    const [rows] = await connection.query(sql, [limit, offset]);

    // Formateo para el componente TSX
    const respuesta = rows.map((item) => ({
      ...item,
      fecha_evento: item.fecha_evento
        ? new Date(item.fecha_evento).toISOString().split("T")[0]
        : "S/F",
      tiene_fotos: item.total_fotos > 0,
      // Convertimos la foto única en un array para que el componente no falle
      fotos: item.foto_principal ? [item.foto_principal] : [],
    }));

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.post("/ocurrencias/registrar/modvehicheck", async (req, res) => {
  let connection;
  try {
    console.log("📩 PETICIÓN RECIBIDA:", req.body.id_camara);

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      vehiculos_detalle,
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsFinales = [];
      if (typeof id_camara === "string" && id_camara.length > 0) {
        idsFinales = id_camara.split(",").map((id) => parseInt(id.trim()));
      } else if (Array.isArray(id_camara)) {
        idsFinales = id_camara.map((id) => parseInt(id));
      }

      const idsLimpios = idsFinales.filter((id) => !isNaN(id));

      if (idsLimpios.length > 0) {
        const valuesCamara = idsLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
        console.log(`✅ ${idsLimpios.length} cámaras vinculadas.`);
      }
    }

    // 3. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.post("/ocurrencias/registrar/modvehi2", async (req, res) => {
  let connection;
  try {
    console.log("📩 PETICIÓN RECIBIDA:", req.body);

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      vehiculos_detalle,
      id_personal_ids, // Array de IDs de personal de apoyo
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
      }
    }

    // 3. INSERTAR PERSONAL DE APOYO (personal_ocurrencia)
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsPersLimpios.length > 0) {
        // Según tu consulta: id_ocurrencia es el 2do campo e id_persona el 3ero
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
        console.log(`✅ ${idsPersLimpios.length} agentes vinculados.`);
      }
    }

    // 4. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    // 5. INSERTAR FOTOS (Restaurado)
    // 3. PROCESAR FOTOS USANDO EL UPLOAD PRESET (RENDERIZADO AUTOMÁTICO)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) => {
          const fileStr = f.base64_data.startsWith("data:")
            ? f.base64_data
            : `data:image/jpeg;base64,${f.base64_data}`;

          // Usamos el preset 'sasas' que configuraste con c_scale,w_1000/q_60
          return cloudinary.uploader.upload(fileStr, {
            upload_preset: "renderizado",
          });
        });

      const uploadResults = await Promise.all(uploadPromises);
      uploadedPublicIds = uploadResults.map((r) => r.public_id);

      const photoValues = uploadResults.map((r) => [
        id_nueva_ocurrencia,
        r.secure_url,
        r.public_id,
      ]);

      await connection.query(
        "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
        [photoValues],
      );
    }
    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/ocurrencias/registrar/modvehi", async (req, res) => {
  let connection;
  try {
    const logData = {
      ...req.body,
      fotos: req.body.fotos
        ? `[${req.body.fotos.length} fotos recibidas en base64]`
        : [],
    };
    console.log("📩 PETICIÓN RECIBIDA:", req.body);

    const {
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      vehiculos_detalle,
      id_personal_ids, // Array de IDs de personal de apoyo
      detalle_llamada, // Objeto: { numero, nombre }
      agresores_detalle, // Array de objetos
      victimas_detalle, // Array de objetos
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. INSERTAR OCURRENCIA PRINCIPAL
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // 2. INSERTAR DETALLE DE CÁMARAS
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
      }
    }

    // 3. INSERTAR PERSONAL DE APOYO (personal_ocurrencia)
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsPersLimpios.length > 0) {
        // Según tu consulta: id_ocurrencia es el 2do campo e id_persona el 3ero
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
        console.log(`✅ ${idsPersLimpios.length} agentes vinculados.`);
      }
    }

    // 4. INSERTAR VEHÍCULOS
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      const valuesV = vehiculos_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.id_tipo_vehiculo,
        v.id_unidad,
        v.tipo_asignacion,
        v.id_pnp,
      ]);
      await connection.query(
        `INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp) VALUES ?`,
        [valuesV],
      );
    }

    // 5. INSERTAR FOTOS (Restaurado)
    // 3. PROCESAR FOTOS USANDO EL UPLOAD PRESET (RENDERIZADO AUTOMÁTICO)
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) => {
          const fileStr = f.base64_data.startsWith("data:")
            ? f.base64_data
            : `data:image/jpeg;base64,${f.base64_data}`;

          return cloudinary.uploader
            .upload(fileStr, {
              upload_preset: "renderizado",
              chunk_size: 6000000, // <--- Sube en bloques de 6MB si el archivo es muy grande
            })
            .catch((err) => {
              console.error(
                "Error subiendo una foto individual a Cloudinary:",
                err,
              );
              return null; // Evita que Promise.all falle por completo
            });
        });

      const uploadResultsRaw = await Promise.all(uploadPromises);
      // Filtramos las subidas que hayan fallado con éxito
      const uploadResults = uploadResultsRaw.filter((r) => r !== null);

      if (uploadResults.length > 0) {
        uploadedPublicIds = uploadResults.map((r) => r.public_id);

        const photoValues = uploadResults.map((r) => [
          id_nueva_ocurrencia,
          r.secure_url,
          r.public_id,
        ]);

        await connection.query(
          "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
          [photoValues],
        );
      }
    }
    // 6. INSERTAR DETALLE DE LLAMADA
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Anónimo",
        ],
      );
    }

    // 7. INSERTAR DETALLE DE AGRESORES
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
    }

    // 8. INSERTAR DETALLE DE VÍCTIMAS
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
    }
    await connection.commit();
    res.status(201).json({ success: true, id: id_nueva_ocurrencia });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// 1007
app.put("/ocurrencias/editarseg/:id_ocurrencia", async (req, res) => {
  let connection;
  try {
    const { id_ocurrencia } = req.params;
    const {
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      nombre_lugar,
      referencia,
      ocurrencia_descripcion,
    } = req.body;

    connection = await db.getConnection();

    // Actualizamos solo los campos que mostraste en tu modal de edición
    const sqlUpdate = `
            UPDATE ocurrencia_registro 
            SET hora_alerta = ?, 
                hora_llegada = ?, 
                hora_repliegue = ?, 
                referencia = ?, 
                descripcion = ?
            WHERE id_ocurrencia = ?`;

    await connection.query(sqlUpdate, [
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      referencia,
      ocurrencia_descripcion,
      id_ocurrencia,
    ]);

    // Nota: Si también quieres actualizar el 'nombre_lugar',
    // deberías tener una lógica para buscar el ID del lugar o actualizar una tabla relacionada.

    res
      .status(200)
      .json({ success: true, message: "Actualizado correctamente" });
  } catch (error) {
    console.error("🔴 ERROR AL EDITAR:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.put("/ocurrencias/editarseg3/:id_ocurrencia", async (req, res) => {
  let connection;
  try {
    const { id_ocurrencia } = req.params;
    const {
      fecha_evento,
      nombre_lugar, // Recibimos el texto del select desde el frontend
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      referencia,
      ocurrencia_descripcion,
      lista_fotos,
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Actualizamos usando un subquery para obtener el id_lugar de la otra tabla dinámicamente
    const sqlUpdate = `
            UPDATE ocurrencia_registro 
            SET fecha_evento = ?,
                id_lugar = (SELECT id_lugar FROM lugar WHERE nombre_lugar = ? LIMIT 1),
                hora_alerta = ?, 
                hora_llegada = ?, 
                hora_repliegue = ?, 
                referencia = ?, 
                descripcion = ?
            WHERE id_ocurrencia = ?`;

    await connection.query(sqlUpdate, [
      fecha_evento,
      nombre_lugar, // Se usa aquí para buscar el id en la tabla 'lugar'
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      referencia,
      ocurrencia_descripcion,
      id_ocurrencia,
    ]);

    // Sincronización de fotos (se mantiene igual)
    if (Array.isArray(lista_fotos)) {
      await connection.query(
        `DELETE FROM foto_ocurrencia_registro WHERE id_ocurrencia = ?`,
        [id_ocurrencia],
      );

      if (lista_fotos.length > 0) {
        const values = lista_fotos.map((foto) => {
          const url =
            typeof foto === "string" ? foto : foto.url_imagen || foto.url;
          const publicId = foto.public_id || null;
          return [id_ocurrencia, url, publicId];
        });

        const sqlInsertFotos = `
                    INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) 
                    VALUES ?`;

        await connection.query(sqlInsertFotos, [values]);
      }
    }

    await connection.commit();
    res
      .status(200)
      .json({ success: true, message: "Actualizado correctamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR AL EDITAR OCURRENCIA:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.put("/ocurrencias/editar/:id_ocurrencia", async (req, res) => {
  let connection;
  try {
    const {
      fecha_evento,
      nombre_lugar,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      referencia,
      ocurrencia_descripcion,
      lista_fotos,
    } = req.body;
    const { id_ocurrencia } = req.params;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Actualizar los datos principales de la ocurrencia
    await connection.query(
      `
            UPDATE ocurrencia_registro 
            SET fecha_evento = ?, 
                id_lugar = (SELECT id_lugar FROM lugar WHERE nombre_lugar = ? LIMIT 1),
                hora_alerta = ?, 
                hora_llegada = ?, 
                hora_repliegue = ?, 
                referencia = ?, 
                descripcion = ?
            WHERE id_ocurrencia = ?`,
      [
        fecha_evento,
        nombre_lugar,
        hora_alerta,
        hora_llegada,
        hora_repliegue,
        referencia,
        ocurrencia_descripcion,
        id_ocurrencia,
      ],
    );

    // 2. Limpiar las fotos anteriores de MySQL para refrescar la lista completa
    await connection.query(
      `DELETE FROM foto_ocurrencia_registro WHERE id_ocurrencia = ?`,
      [id_ocurrencia],
    );

    // 3. Procesar la nueva lista de fotos (tanto las existentes como las nuevas en Base64)
    if (Array.isArray(lista_fotos) && lista_fotos.length > 0) {
      const valoresFotos = [];

      for (let [idx, foto] of lista_fotos.entries()) {
        let urlImagen =
          typeof foto === "string" ? foto : foto.url_imagen || foto.url;
        let publicId = foto.public_id || null;

        // SI LA FOTO ES NUEVA (Viene en formato Base64 desde el FileReader web o móvil)
        if (urlImagen && urlImagen.startsWith("data:image")) {
          try {
            // Remueve cualquier encabezado data URI independientemente del formato (png, jpg, webp, etc.)
const base64Clean = urlImagen.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
            const bufferOriginal = Buffer.from(base64Clean, "base64");

            // Optimizar con Sharp
            const bufferOptimizado = await sharp(bufferOriginal)
              .resize({ width: 1200, withoutEnlargement: true })
              .jpeg({ quality: 75 })
              .toBuffer();

            const timestamp = Date.now();
            const fechaActual = new Date();
            const anio = fechaActual.getFullYear();
            const mes = String(fechaActual.getMonth() + 1).padStart(2, "0");
            const nombreArchivo = `ocurrencias/${anio}/${mes}/${id_ocurrencia}_edit_${idx}_${timestamp}.jpg`;

            // Subir a Cloudflare R2
            await r2Client.send(
              new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: nombreArchivo,
                Body: bufferOptimizado,
                ContentType: "image/jpeg",
              }),
            );

            urlImagen = `${PUBLIC_DOMAIN}/${nombreArchivo}`;
            publicId = nombreArchivo;
          } catch (errSharp) {
            console.error(
              `🔴 Error procesando imagen nueva [${idx}]:`,
              errSharp.message,
            );
            continue;
          }
        } else {
          // SI LA FOTO YA EXISTE (Mantiene su URL pública de R2)
          if (!publicId && urlImagen && urlImagen.includes(PUBLIC_DOMAIN)) {
            publicId = urlImagen.replace(`${PUBLIC_DOMAIN}/`, "");
          }
        }

        valoresFotos.push([id_ocurrencia, urlImagen, publicId]);
      }

      // 4. Insertar las fotos actualizadas de golpe en MySQL
      if (valoresFotos.length > 0) {
        const sqlInsertFotos = `
                    INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) 
                    VALUES ?`;
        await connection.query(sqlInsertFotos, [valoresFotos]);
      }
    }

    await connection.commit();
    res.status(200).json({
      success: true,
      message: "Ocurrencia y fotos actualizadas correctamente",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR AL EDITAR OCURRENCIA:", error.message);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/catalogos/completo/unificado", async (req, res) => {
  let connection;
  // Extraemos el tipo de vía si viene en el query (para la carga de lugares)
  const { tipoLugar } = req.query;

  try {
    connection = await db.getConnection();

    // Definimos las consultas base que siempre se ejecutan
    const queries = [
      connection.query(
        "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
      ),
      connection.query(`
                SELECT u.id_usuario AS value, 
                CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),
      connection.query(
        "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
      ),
      connection.query(
        'SELECT id_camara AS value, CONCAT(codigo_camara, " - ", nombre_camara) AS label FROM camara ORDER BY codigo_camara ASC',
      ),
      connection.query(
        "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje ORDER BY nombre",
      ),
      connection.query(
        "SELECT id_modalidadp AS value, nombre AS label FROM modalidad_patrullaje ORDER BY nombre",
      ),
      connection.query(
        "SELECT id_tipo_via AS value, abreviatura AS label FROM tipo_via ORDER BY abreviatura ASC",
      ),
    ];

    // Si tipoLugar está presente, añadimos la consulta de lugares al array de promesas
    if (tipoLugar) {
      queries.push(
        connection.query(
          `
                    SELECT 
                        l.id_lugar AS value, 
                        CONCAT(tv.abreviatura, ' ', v.nombre_via, ' CDRA. ', c.numero_cuadra) AS label 
                    FROM lugar l
                    INNER JOIN cuadra c ON l.id_cuadra = c.id_cuadra
                    INNER JOIN via v ON l.id_via = v.id_via
                    INNER JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
                    WHERE l.id_tipo_lugar = ?
                    ORDER BY v.nombre_via ASC, c.numero_cuadra ASC
                `,
          [tipoLugar],
        ),
      );
    }

    const results = await Promise.all(queries);

    // Mapeo de resultados
    const response = {
      modalidades: results[0][0],
      usuarios: results[1][0],
      origenes: results[2][0],
      camaras: results[3][0],
      tipos_patrullaje: results[4][0],
      modalidades_patrullaje: results[5][0],
      tipos_via: results[6][0],
    };

    // Si se consultaron lugares, se agregan al objeto final
    if (tipoLugar) {
      response.lugares = results[7][0];
    }

    res.json(response);
  } catch (error) {
    console.error("Error al cargar catálogos consolidados:", error);
    res.status(500).json({ error: "Error interno al cargar catálogos" });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/catalogos/completo/unificadof", async (req, res) => {
  let connection;
  // Extraemos tipoLugar e idTipoP de la URL
  // Ejemplo: /catalogos/completo/unificado?tipoLugar=2&idTipoP=1
  const { tipoLugar, idTipoP } = req.query;

  try {
    connection = await db.getConnection();

    // Definimos las consultas base
    const queries = [
      connection.query(
        "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
      ),
      connection.query(`
                SELECT u.id_usuario AS value, 
                CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),
      connection.query(
        "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
      ),
      connection.query(
        'SELECT id_camara AS value, CONCAT(codigo_camara, " - ", nombre_camara) AS label FROM camara ORDER BY codigo_camara ASC',
      ),

      // MODIFICACIÓN: Consulta dinámica de tipo_patrullaje
      idTipoP
        ? connection.query(
            "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje WHERE id_tipop IN (?)",
            [idTipoP],
          )
        : connection.query(
            "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje ORDER BY nombre",
          ),

      connection.query(
        "SELECT id_modalidadp AS value, nombre AS label FROM modalidad_patrullaje ORDER BY nombre",
      ),
      connection.query(
        "SELECT id_tipo_via AS value, abreviatura AS label FROM tipo_via ORDER BY abreviatura ASC",
      ),
    ];

    // Consulta de lugares (se mantiene igual)
    if (tipoLugar) {
      queries.push(
        connection.query(
          `
                    SELECT 
                        l.id_lugar AS value, 
                        CONCAT(tv.abreviatura, ' ', v.nombre_via, ' CDRA. ', c.numero_cuadra) AS label 
                    FROM lugar l
                    INNER JOIN cuadra c ON l.id_cuadra = c.id_cuadra
                    INNER JOIN via v ON l.id_via = v.id_via
                    INNER JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
                    WHERE l.id_tipo_lugar = ?
                    ORDER BY v.nombre_via ASC, c.numero_cuadra ASC
                `,
          [tipoLugar],
        ),
      );
    }

    const results = await Promise.all(queries);

    const response = {
      modalidades: results[0][0],
      usuarios: results[1][0],
      origenes: results[2][0],
      camaras: results[3][0],
      tipos_patrullaje: results[4][0], // Contendrá solo el ID solicitado o todos si no se envió idTipoP
      modalidades_patrullaje: results[5][0],
      tipos_via: results[6][0],
    };

    if (tipoLugar) {
      response.lugares = results[7][0];
    }

    res.json(response);
  } catch (error) {
    console.error("Error al cargar catálogos consolidados:", error);
    res.status(500).json({ error: "Error interno al cargar catálogos" });
  } finally {
    if (connection) connection.release();
  }
});
app.get("/catalogos/completo/unificadov", async (req, res) => {
  let connection;
  const { tipoLugar, idTipoP } = req.query;

  try {
    connection = await db.getConnection();

    const queries = [
      connection.query(
        "SELECT id AS value, nombre AS label FROM cat_modalidad ORDER BY nombre",
      ),
      connection.query(`
                SELECT u.id_usuario AS value, 
                CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS label 
                FROM usuarios_sistema u 
                INNER JOIN persona p ON u.id_usuario = p.id_persona
                WHERE p.estado_laboral = 'ACTIVO'
                ORDER BY p.apellido_paterno, p.nombres
            `),
      connection.query(
        "SELECT id_origen AS value, descripcion AS label FROM origen ORDER BY descripcion",
      ),
      // 1. Modificamos cámaras para que solo liste las activas (estado 1)
      connection.query(
        'SELECT id_camara AS value, CONCAT(codigo_camara, " - ", nombre_camara) AS label FROM camara WHERE estado = 1 ORDER BY codigo_camara ASC',
      ),

      idTipoP
        ? connection.query(
            "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje WHERE id_tipop IN (?)",
            [idTipoP],
          )
        : connection.query(
            "SELECT id_tipop AS value, nombre AS label FROM tipo_patrullaje ORDER BY nombre",
          ),

      connection.query(
        "SELECT id_modalidadp AS value, nombre AS label FROM modalidad_patrullaje ORDER BY nombre",
      ),
      connection.query(
        "SELECT id_tipo_via AS value, abreviatura AS label FROM tipo_via ORDER BY abreviatura ASC",
      ),

      // 2. NUEVA CONSULTA: Listado de Personal Operativo
      connection.query(`
                SELECT 
                    id_persona AS value, 
                    CONCAT(apellido_paterno, ' ', apellido_materno, ', ', nombres) AS label,
                    documento_numero,
                    cargo_operativo,
                    foto_perfil
                FROM personal_operativo 
                WHERE estado = 1 
                ORDER BY apellido_paterno ASC
            `),
    ];

    if (tipoLugar) {
      queries.push(
        connection.query(
          `
                    SELECT 
                        l.id_lugar AS value, 
                        l.nombre_lugar AS label 
                    FROM lugar l
                   
                    WHERE l.id_tipo_lugar = ?
                  
                `,
          [tipoLugar],
        ),
      );
    }

    const results = await Promise.all(queries);

    const response = {
      modalidades: results[0][0],
      usuarios: results[1][0],
      origenes: results[2][0],
      camaras: results[3][0],
      tipos_patrullaje: results[4][0],
      modalidades_patrullaje: results[5][0],
      tipos_via: results[6][0],
      // 3. Agregamos el resultado a la respuesta JSON
      personal_operativo: results[7][0],
    };

    if (tipoLugar) {
      response.lugares = results[8][0]; // El índice cambia a 8 porque agregamos uno antes
    }

    res.json(response);
  } catch (error) {
    console.error("Error al cargar catálogos consolidados:", error);
    res.status(500).json({ error: "Error interno al cargar catálogos" });
  } finally {
    if (connection) connection.release();
  }
});
// En tu servidor (archivo de rutas)
app.get("/catalogos/lugares", async (req, res) => {
  // Si envías ?tipo=2, tipoLugar valdrá '2'
  const { tipo } = req.query;
  try {
    const [rows] = await db.query(
      "SELECT id_lugar AS value, nombre_lugar AS label FROM lugar WHERE id_tipo_lugar = ?",
      [tipo], // Aquí se inyecta el valor de forma segura
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/catalogos/modalidad", async (req, res) => {
  const { tipo } = req.query; // Si ya no lo usas, puedes omitirlo o dejarlo por si lo necesitas luego
  try {
    const [rows] = await db.query(
      "SELECT id AS value, nombre AS label FROM cat_modalidad",
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/catalogos/camposipcop", async (req, res) => {
  const { id } = req.query; // Si necesitas el ID para editar, puedes recibirlo por query o params
  try {
    // 1. Ejecutas todas las consultas de tus 5 tablas en paralelo
    const [medioRows] = await db.query(
      "SELECT id_medio AS value, descripcion AS label FROM sipcop_medio",
    );
    const [lugarsRows] = await db.query(
      "SELECT id_lugarsip AS value, descripcion AS label FROM sipcop_lugar",
    );
    const [consecuenciaRows] = await db.query(
      "SELECT id_consecuencia AS value, descripcion AS label FROM sipcop_consecuencia",
    );
    const [resultadoRows] = await db.query(
      "SELECT id_resultado AS value, descripcion AS label FROM sipcop_resultado",
    );
    const [relacionRows] = await db.query(
      "SELECT id_relacion_v AS value, descripcion AS label FROM sipcop_relacion_v",
    );

    // 2. Si estás editando y pasas un ID, también puedes buscar el registro actual aquí mismo:
    let registroActual = {};
    if (id) {
      const [ocurrenciaRows] = await db.query(
        "SELECT * FROM ocurrencia_registro WHERE id_ocurrencia = ?",
        [id],
      );
      registroActual = ocurrenciaRows[0] || {};
    }

    // 3. Devuelves todo en un solo objeto JSON ordenado
    res.json({
      medios: medioRows,
      lugares: lugarsRows,
      consecuencias: consecuenciaRows,
      resultados: resultadoRows,
      relaciones: relacionRows,
      registro: registroActual, // Los valores actuales para cuando edites
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/ocurrencias/listar/tabla", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // Consulta SQL limpia sin LIMIT para paginación del lado del cliente
    const sql = `
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.distancia_metros,
            
            -- Muestra la placa y su descripción de vehículo entre paréntesis
            IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
               CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
               spf.placa
            ) AS placa_con_tipo,
            
            ovd.tipo_asignacion,
            o.codigo_seguimiento,
            ori.descripcion AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            l.nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            
            -- Información de la Persona (Usuario que registra)
            p.documento_numero AS persona_dni,
            CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,

            -- Nombres de catálogos
            m.nombre AS modalidad_nombre,
            v.nombre_via AS via_nombre,
            c.numero_cuadra AS cuadra,
            tp.nombre AS tipo_patrullaje_nombre,
            mp.nombre AS mod_patrullaje_nombre,

            -- Ubicación formateada
            l.id_lugar AS value, 
            CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, '')) AS label,
            
            -- Subconsultas para fotos
            (SELECT COUNT(*) FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia) AS total_fotos,
            
            (SELECT url_imagen FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia LIMIT 1) AS foto_principal

        FROM ocurrencia_registro o
        -- Relación con Persona / Usuario
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona

        -- Catálogos de ubicación
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via

        -- Origen e Infraestructura
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id

        -- RELACIÓN CON VEHÍCULOS, FLOTA MUNICIPAL Y TIPOS DE VEHÍCULO
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo

        -- Tipos de patrullaje
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp

       ORDER BY o.fecha_reporte DESC LIMIT 1000
        `;

    const [rows] = await connection.query(sql);

    // Formateo mapeado para tu componente TSX de Frontend
    const respuesta = rows.map((item) => ({
      ...item,
      fecha_evento: item.fecha_evento
        ? new Date(item.fecha_evento).toISOString().split("T")[0]
        : "S/F",
      tiene_fotos: item.total_fotos > 0,
      fotos: item.foto_principal ? [item.foto_principal] : [],
    }));

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/modvehi:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
const XLSX = require('xlsx');

app.get("/ocurrencias/exportar-excel-totalseg", async (req, res) => {
  let connection;
  const { fecha_inicio, fecha_fin } = req.query;

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ success: false, message: "Faltan las fechas de inicio y fin" });
  }

  try {
    connection = await db.getConnection();
    console.log(`Iniciando exportación Excel para el rango: ${fecha_inicio} hasta ${fecha_fin}`);

    // Consulta con los mismos campos formateados para que el Excel salga completo e idéntico a tu vista
    const sql = `
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.distancia_metros,
            
            IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
               CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
               spf.placa
            ) AS placa_con_tipo,
            
            ovd.tipo_asignacion,
            o.codigo_seguimiento,
            ori.descripcion AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            l.nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            
            p.documento_numero AS persona_dni,
            CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,

            m.nombre AS modalidad_nombre,
            v.nombre_via AS via_nombre,
            c.numero_cuadra AS cuadra,
            tp.nombre AS tipo_patrullaje_nombre,
            mp.nombre AS mod_patrullaje_nombre,

            CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, '')) AS label

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp

        WHERE o.fecha_reporte BETWEEN ? AND ?
        ORDER BY o.fecha_reporte DESC
    `;

    // Pasamos las fechas como parámetros seguros para evitar inyecciones SQL
    const [rows] = await connection.query(sql, [fecha_inicio, fecha_fin]);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "No hay registros en este rango de fechas" });
    }

    // Crear la hoja de Excel en memoria usando xlsx
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Historial_Operativo");
    
    // Generar el archivo binario
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // Enviar el archivo como respuesta de descarga directa al navegador
    res.setHeader('Content-Disposition', 'attachment; filename="Reporte_SIPCOP_General.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);

  } catch (error) {
    console.error("ERROR EN /ocurrencias/exportar-excel:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.get("/ocurrencias/exportar-excel-total", async (req, res) => {
  let connection;
  const { fecha_inicio, fecha_fin } = req.query;

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ success: false, message: "Faltan las fechas de inicio y fin" });
  }

  try {
    connection = await db.getConnection();
    console.log(`Iniciando exportación Excel optimizada en servidor para el rango: ${fecha_inicio} hasta ${fecha_fin}`);

    const sql = `
        WITH pnp_agg AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', CONCAT(IFNULL(apellidos, ''), ', ', IFNULL(nombres, ''), ' (DNI: ', IFNULL(dni, '-'), ', Grado: ', IFNULL(grado, '-'), ')')) ORDER BY pos SEPARATOR '\n') AS pnp_datos
            FROM (
                SELECT ovd.id_ocurrencia, ovd.id_detalle, cp.apellidos, cp.nombres, cp.dni, cp.grado,
                       ROW_NUMBER() OVER (PARTITION BY ovd.id_ocurrencia ORDER BY ovd.id_detalle) AS pos
                FROM ocurrencia_vehiculo_detalle ovd
                INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
            ) sub_pnp
            GROUP BY id_ocurrencia
        ),
        vic_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_victima, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS victimas_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS victimas_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_victima, '')) ORDER BY pos SEPARATOR '\n') AS victimas_placas,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(rv.descripcion, 'SIN RELACIÓN')) ORDER BY pos SEPARATOR '\n') AS victimas_relacion
            FROM (
                SELECT id_ocurrencia, id_detalle_victima, nombre_victima, edad, placa_victima, id_relacion_v,
                       ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos
                FROM detalle_victimas_ocurrencia
            ) dv
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
            GROUP BY id_ocurrencia
        ),
        agr_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_agresor, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS agresores_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS agresores_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_agresor, '')) ORDER BY pos SEPARATOR '\n') AS agresores_placas
            FROM (
                SELECT id_ocurrencia, id_detalle_agresor, nombre_agresor, edad, placa_agresor,
                       ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos
                FROM detalle_agresores_ocurrencia
            ) agr
            GROUP BY id_ocurrencia
        ),
        foto_agg AS (
            SELECT 
                id_ocurrencia,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM (
                SELECT id_ocurrencia, url_imagen, id_foto,
                       ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_foto) AS nro
                FROM foto_ocurrencia_registro
            ) f_base 
            GROUP BY id_ocurrencia
        )
        SELECT 
            o.id_ocurrencia AS ID,
          DATE_FORMAT(o.fecha_reporte, '%d/%m/%Y %H:%i:%s') AS MARCA_TEMPORAL,
            p.documento_numero AS DNI_SERENO,
            CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS APELLIDOS_NOMBRES,
            ori.descripcion AS ORIGEN,
            tp.nombre AS TIPO_PATRULLAJE,
            mp.nombre AS MODALIDAD_PATRULLAJE,
            tvh.descripcion AS TIPO_UNIDAD,
            spf.placa AS PLACA,
            o.turnr AS TURNO,
          TIME_FORMAT(o.hora_alerta, '%H:%i') AS HORA_ALERTA,
            TIME_FORMAT(o.hora_llegada, '%H:%i') AS HORA_LLEGADA,
            TIME_FORMAT(o.hora_repliegue, '%H:%i') AS HORA_REPLIEGUE,
           DATE_FORMAT(o.fecha_evento, '%d/%m/%Y') AS FECHA_OCURRENCIA,
            o.referencia AS REFERENCIA,
            l.nombre_lugar AS DIRECCIÓN_CONSOLIDADA,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS COORDENADA,
            o.descripcion AS DATOS_IMPORTANTES,
            foto_agg.foto_1 AS ADJUNTO_1,
            foto_agg.foto_2 AS ADJUNTO_2,
            foto_agg.foto_3 AS ADJUNTO_3,
            foto_agg.foto_4 AS ADJUNTO_4,
            cgen.nombre AS GENERICO,
            cesp.nombre AS ESPECIFICO,
            m.nombre AS MODALIDAD,
            pnp_agg.pnp_datos AS DATOS_EFECTIVO,
            SR.descripcion AS RESULTADO,
            SC.descripcion AS CONSECUENCIA,
            SL.descripcion AS LUGAR,
            SM.descripcion AS MEDIO,
            o.estado_involucrados AS IDENTIDAD,
            v_grp.victimas_nombres AS VICTIMA_NOMBRE,
            v_grp.victimas_edades AS VICTIMA_EDAD,
            v_grp.victimas_placas AS VICTIMA_PLACA,
            v_grp.victimas_relacion AS RELACION_CON_AGRESOR,
            a_grp.agresores_nombres AS AGRESOR_NOMBRE,
            a_grp.agresores_edades AS AGRESOR_EDAD,
            a_grp.agresores_placas AS AGRESOR_PLACA,
 
         IF(o.codigo_seguimiento IS NOT NULL AND TRIM(o.codigo_seguimiento) != '', 
               CONCAT(o.codigo_seguimiento, '-MDJM-GSC-SGS'), 
               ''
            ) AS NUMERO_DOCUMENTO,
             o.estado AS ESTADO

        FROM ocurrencia_registro o
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN cat_especifica cesp ON m.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real

        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo

        LEFT JOIN pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN vic_grouped v_grp ON v_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN agr_grouped a_grp ON a_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia

        WHERE o.fecha_reporte BETWEEN ? AND ?
        ORDER BY o.fecha_reporte DESC
    `;

    const [rows] = await connection.query(sql, [fecha_inicio, fecha_fin]);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "No hay registros en este rango de fechas" });
    }

    // Crear la hoja de Excel directamente en Node.js
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Historial_Operativo");
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', 'attachment; filename="Reporte_SIPCOP_General.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);

  } catch (error) {
    console.error("ERROR EN /ocurrencias/exportar-excel-total:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// Función helper para parsear JSON de forma segura y limpia
const safeJSONParse = (jsonString, fallback = []) => {
  if (!jsonString) return fallback;
  try {
    return typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;
  } catch (e) {
    return fallback;
  }
};



app.get("/ocurrencias/listar/tablasipcop-rango", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // 1. Paginación
    const page = Math.max(1, parseInt(req.query.page || req.query.pagina) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit || req.query.limite) || 50),
      50
    );
    const offset = (page - 1) * limit;

    // 2. Parámetros de rango (Soporta camelCase del frontend y snake_case)
    const fecha_inicio = req.query.fechaInicio || req.query.fecha_inicio;
    const fecha_fin = req.query.fechaFin || req.query.fecha_fin;

    let whereClause = "";
    const paramsWhere = [];

    if (fecha_inicio && fecha_fin) {
      whereClause = `WHERE o.fecha_reporte BETWEEN ? AND ?`;
      paramsWhere.push(fecha_inicio, fecha_fin);
    } else {
      whereClause = `WHERE o.fecha_reporte >= NOW() - INTERVAL 7 DAY`;
    }

    // 3. Conteo total exacto de ocurrencias
    const countSql = `
      SELECT COUNT(o.id_ocurrencia) AS total 
      FROM ocurrencia_registro o
      ${whereClause}
    `;
    const [countRows] = await connection.query(countSql, paramsWhere);
    const totalRegistros = countRows[0]?.total || 0;

    // 4. Consulta principal optimizada (Sin JOINs multiplicativos)
    const sql = `
        SELECT 
            o.id_ocurrencia,
            DATE_FORMAT(o.fecha_reporte, '%Y-%m-%d %H:%i:%s') AS fecha_reporte,
            DATE_FORMAT(o.fecha_evento, '%Y-%m-%d') AS fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.distancia_metros,
            o.referencia,
            o.unidad_encargada,
            o.descripcion AS ocurrencia_descripcion,
            o.codigo_seguimiento,
            o.estado,
            o.patrimonio_real,
            o.arresto_ciudadano,
            
            -- Datos de Persona y Usuario
            CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,
            p.documento_numero AS persona_dni,
            
            -- Datos de Llamada, Origen, Modalidad y Ubicación
            dlo.numero_telefono,
            dlo.nombre_informante,
            m.nombre AS modalidad_nombre,
            ori.descripcion AS origen_descripcion,
            tp.nombre AS tipo_patrullaje_nombre,
            l.nombre_lugar,
            v.nombre_via AS via_nombre,

          (SELECT COALESCE(
                JSON_ARRAYAGG(
                    IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                       CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                       spf.placa)
                ),
                JSON_ARRAY()
             )
             FROM ocurrencia_vehiculo_detalle ovd
             LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
             LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
             WHERE ovd.id_ocurrencia = o.id_ocurrencia
            ) AS vehiculos_json,

            -- Subconsulta JSON: Cámaras
            (SELECT COALESCE(
                JSON_ARRAYAGG(camar.nombre_camara),
                JSON_ARRAY()
             ) 
             FROM detalle_camara_ocurrencia dcam 
             INNER JOIN camara camar ON dcam.id_camara = camar.id_camara 
             WHERE dcam.id_ocurrencia = o.id_ocurrencia
            ) AS camaras_json,
            
            -- Subconsulta JSON: Fotos
            (SELECT COALESCE(
                JSON_ARRAYAGG(f.url_imagen),
                JSON_ARRAY()
             ) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia AND f.url_imagen IS NOT NULL
            ) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia

        ${whereClause}

        ORDER BY o.fecha_reporte DESC 
        LIMIT ? OFFSET ?
    `;

    const queryParams = [...paramsWhere, limit, offset];
    const [rows] = await connection.query(sql, queryParams);

    // 5. Mapeo seguro de arrays JSON
    const datosMapeados = rows.map((item) => {
      let listaFotos = [];
      let listaCamaras = [];
      let listaVehiculos = [];

      try { listaFotos = item.fotos_json ? JSON.parse(item.fotos_json) : []; } catch (e) {}
      try { listaCamaras = item.camaras_json ? JSON.parse(item.camaras_json) : []; } catch (e) {}
      try { listaVehiculos = item.vehiculos_json ? JSON.parse(item.vehiculos_json) : []; } catch (e) {}

      return {
        ...item,
        fecha_evento: item.fecha_evento || "S/F",
        fecha_reporte: item.fecha_reporte || "S/F",
        
        // Mantenemos retrocompatibilidad con campos de UI
        placa_con_tipo: listaVehiculos.length > 0 ? listaVehiculos.join(", ") : "Sin unidad",
        vehiculos: listaVehiculos,
        camaras: listaCamaras,
        
        // Fotos
        total_fotos: listaFotos.length,
        tiene_fotos: listaFotos.length > 0,
        foto_principal: listaFotos[0] || null,
        fotos: listaFotos,
        lista_fotos: listaFotos
      };
    });

    res.json({
      success: true,
      total: totalRegistros,
      paginaActual: page,
      registrosPorPagina: limit,
      data: datosMapeados,
    });

  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/tablasipcop-rango:", error);
    res.status(500).json({ success: false, total: 0, data: [] });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/listar/tablasipcop-rango12hseg", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // 1. Paginación
    const page = Math.max(1, parseInt(req.query.page || req.query.pagina) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit || req.query.limite) || 50),
      50
    );
    const offset = (page - 1) * limit;

    // 2. Parámetros de rango (Soporta camelCase del frontend y snake_case)
    const fecha_inicio = req.query.fechaInicio || req.query.fecha_inicio;
    const fecha_fin = req.query.fechaFin || req.query.fecha_fin;

    let whereClause = "";
    const paramsWhere = [];

   if (fecha_inicio && fecha_fin) {
  whereClause = `WHERE o.fecha_reporte BETWEEN ? AND ?`;
  paramsWhere.push(fecha_inicio, fecha_fin);
} else {
  // Garantiza el filtro automático de las últimas 12 horas al cargar por primera vez
  whereClause = `WHERE o.fecha_reporte >= NOW() - INTERVAL 12 HOUR`;
}
    // 3. Conteo total exacto de ocurrencias
    const countSql = `
      SELECT COUNT(o.id_ocurrencia) AS total 
      FROM ocurrencia_registro o
      ${whereClause}
    `;
    const [countRows] = await connection.query(countSql, paramsWhere);
    const totalRegistros = countRows[0]?.total || 0;

    // 4. Consulta principal optimizada (Sin JOINs multiplicativos)
    const sql = `
        SELECT 
            o.id_ocurrencia,
            DATE_FORMAT(o.fecha_reporte, '%Y-%m-%d %H:%i:%s') AS fecha_reporte,
            DATE_FORMAT(o.fecha_evento, '%Y-%m-%d') AS fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.distancia_metros,
            o.referencia,
            o.unidad_encargada,
            o.descripcion AS ocurrencia_descripcion,
            o.codigo_seguimiento,
            o.estado,
            o.patrimonio_real,
            o.arresto_ciudadano,
            
            -- Datos de Persona y Usuario
            CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,
            p.documento_numero AS persona_dni,
            
            -- Datos de Llamada, Origen, Modalidad y Ubicación
            dlo.numero_telefono,
            dlo.nombre_informante,
            m.nombre AS modalidad_nombre,
            ori.descripcion AS origen_descripcion,
            tp.nombre AS tipo_patrullaje_nombre,
            l.nombre_lugar,
            v.nombre_via AS via_nombre,

          (SELECT COALESCE(
                JSON_ARRAYAGG(
                    IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                       CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                       spf.placa)
                ),
                JSON_ARRAY()
             )
             FROM ocurrencia_vehiculo_detalle ovd
             LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
             LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
             WHERE ovd.id_ocurrencia = o.id_ocurrencia
            ) AS vehiculos_json,

            -- Subconsulta JSON: Cámaras
            (SELECT COALESCE(
                JSON_ARRAYAGG(camar.nombre_camara),
                JSON_ARRAY()
             ) 
             FROM detalle_camara_ocurrencia dcam 
             INNER JOIN camara camar ON dcam.id_camara = camar.id_camara 
             WHERE dcam.id_ocurrencia = o.id_ocurrencia
            ) AS camaras_json,
            
            -- Subconsulta JSON: Fotos
            (SELECT COALESCE(
                JSON_ARRAYAGG(f.url_imagen),
                JSON_ARRAY()
             ) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia AND f.url_imagen IS NOT NULL
            ) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia

        ${whereClause}

        ORDER BY o.fecha_reporte DESC 
        LIMIT ? OFFSET ?
    `;

    const queryParams = [...paramsWhere, limit, offset];
    const [rows] = await connection.query(sql, queryParams);

    // 5. Mapeo seguro de arrays JSON
    const datosMapeados = rows.map((item) => {
      let listaFotos = [];
      let listaCamaras = [];
      let listaVehiculos = [];

      try { listaFotos = item.fotos_json ? JSON.parse(item.fotos_json) : []; } catch (e) {}
      try { listaCamaras = item.camaras_json ? JSON.parse(item.camaras_json) : []; } catch (e) {}
      try { listaVehiculos = item.vehiculos_json ? JSON.parse(item.vehiculos_json) : []; } catch (e) {}

      return {
        ...item,
        fecha_evento: item.fecha_evento || "S/F",
        fecha_reporte: item.fecha_reporte || "S/F",
        
        // Mantenemos retrocompatibilidad con campos de UI
        placa_con_tipo: listaVehiculos.length > 0 ? listaVehiculos.join(", ") : "Sin unidad",
        vehiculos: listaVehiculos,
        camaras: listaCamaras,
        
        // Fotos
        total_fotos: listaFotos.length,
        tiene_fotos: listaFotos.length > 0,
        foto_principal: listaFotos[0] || null,
        fotos: listaFotos,
        lista_fotos: listaFotos
      };
    });

    res.json({
      success: true,
      total: totalRegistros,
      paginaActual: page,
      registrosPorPagina: limit,
      data: datosMapeados,
    });

  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/tablasipcop-rango:", error);
    res.status(500).json({ success: false, total: 0, data: [] });
  } finally {
    if (connection) connection.release();
  }
});
app.get("/ocurrencias/listar/tablasipcop-rango12h", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const page = Math.max(1, parseInt(req.query.page || req.query.pagina) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit || req.query.limite) || 50),
      50
    );
    const offset = (page - 1) * limit;

    const fecha_inicio = req.query.fechaInicio || req.query.fecha_inicio;
    const fecha_fin = req.query.fechaFin || req.query.fecha_fin;
    
    // RECIBIMOS EL ID DEL USUARIO DESDE LA SESIÓN
    const idUsuarioLogueado = req.query.id_usuario;

    let whereConditions = [];
    const paramsWhere = [];

    if (fecha_inicio && fecha_fin) {
      whereConditions.push(`o.fecha_reporte BETWEEN ? AND ?`);
      paramsWhere.push(fecha_inicio, fecha_fin);
    } else {
      whereConditions.push(`o.fecha_reporte >= NOW() - INTERVAL 12 HOUR`);
    }

   // Si el frontend envía el id_usuario, filtramos estrictamente los registros de ese usuario
    if (idUsuarioLogueado) {
      whereConditions.push(`o.id_usuario = ?`);
      paramsWhere.push(idUsuarioLogueado);
    }

    const whereClause = `WHERE ` + whereConditions.join(" AND ");

    // El resto de tu consulta SQL (countSql y la principal) se mantiene igual...
    const countSql = `
      SELECT COUNT(o.id_ocurrencia) AS total 
      FROM ocurrencia_registro o
      ${whereClause}
    `;
    const [countRows] = await connection.query(countSql, paramsWhere);
    const totalRegistros = countRows[0]?.total || 0;

    // 4. Consulta principal optimizada (Sin JOINs multiplicativos)
    const sql = `
        SELECT 
            o.id_ocurrencia,
            DATE_FORMAT(o.fecha_reporte, '%Y-%m-%d %H:%i:%s') AS fecha_reporte,
            DATE_FORMAT(o.fecha_evento, '%Y-%m-%d') AS fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.distancia_metros,
            o.referencia,
            o.unidad_encargada,
            o.descripcion AS ocurrencia_descripcion,
            o.codigo_seguimiento,
            o.estado,
            o.patrimonio_real,
            o.arresto_ciudadano,
            
           -- Datos de Persona y Usuario
    CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS persona_nombre_completo,
    p.documento_numero AS persona_dni,
   
    -- Datos de Llamada, Origen, Modalidad y Ubicación
    dlo.numero_telefono,
    dlo.nombre_informante,
    m.nombre AS modalidad_nombre,
    ori.descripcion AS origen_descripcion,
    tp.nombre AS tipo_patrullaje_nombre,
    l.nombre_lugar,
    v.nombre_via AS via_nombre,
    
    -- Subconsulta corregida para el PNP (reemplaza el JOIN inválido)
    (SELECT CONCAT_WS(' ', pnp_sub.grado, pnp_sub.nombres, pnp_sub.apellidos)
     FROM ocurrencia_vehiculo_detalle ovd_sub
     INNER JOIN cat_pnp pnp_sub ON ovd_sub.id_pnp = pnp_sub.id_pnp
     WHERE ovd_sub.id_ocurrencia = o.id_ocurrencia AND ovd_sub.id_pnp IS NOT NULL
     LIMIT 1
    ) AS pnp_nombre_completo,

    -- Subconsulta JSON: Vehículos
    (SELECT COALESCE(
        JSON_ARRAYAGG(
            IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
               CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
               spf.placa)
        ),
        JSON_ARRAY()
       )
     FROM ocurrencia_vehiculo_detalle ovd
     LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
     LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
     WHERE ovd.id_ocurrencia = o.id_ocurrencia
    ) AS vehiculos_json,

    -- Subconsulta JSON: Cámaras
    (SELECT COALESCE(
        JSON_ARRAYAGG(camar.nombre_camara),
        JSON_ARRAY()
       ) 
     FROM detalle_camara_ocurrencia dcam 
     INNER JOIN camara camar ON dcam.id_camara = camar.id_camara 
     WHERE dcam.id_ocurrencia = o.id_ocurrencia
    ) AS camaras_json,
    
    -- Subconsulta JSON: Fotos
    (SELECT COALESCE(
        JSON_ARRAYAGG(f.url_imagen),
        JSON_ARRAY()
       ) 
     FROM foto_ocurrencia_registro f 
     WHERE f.id_ocurrencia = o.id_ocurrencia AND f.url_imagen IS NOT NULL
    ) AS fotos_json

FROM ocurrencia_registro o
LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
LEFT JOIN persona p ON us.id_persona = p.id_persona
LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
LEFT JOIN via v ON l.id_via = v.id_via
LEFT JOIN origen ori ON o.id_origen = ori.id_origen 
LEFT JOIN cat_modalidad m ON o.id_modalidad_inicial = m.id
LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        ${whereClause}

        ORDER BY o.fecha_reporte DESC 
        LIMIT ? OFFSET ?
    `;

    const queryParams = [...paramsWhere, limit, offset];
    const [rows] = await connection.query(sql, queryParams);

    // 5. Mapeo seguro de arrays JSON
    // 5. Mapeo seguro de arrays JSON blindado
      const datosMapeados = rows.map((item) => {
        let listaFotos = [];
        let listaCamaras = [];
        let listaVehiculos = [];

        // Parseo seguro para fotos (maneja tanto string JSON como arrays directos de MySQL)
        try {
          if (item.fotos_json) {
            if (Array.isArray(item.fotos_json)) {
              listaFotos = item.fotos_json;
            } else if (typeof item.fotos_json === "string") {
              listaFotos = JSON.parse(item.fotos_json);
            }
          }
        } catch (e) {
          listaFotos = [];
        }

        try {
          if (item.camaras_json) {
            listaCamaras = Array.isArray(item.camaras_json) ? item.camaras_json : JSON.parse(item.camaras_json);
          }
        } catch (e) {
          listaCamaras = [];
        }

        try {
          if (item.vehiculos_json) {
            listaVehiculos = Array.isArray(item.vehiculos_json) ? item.vehiculos_json : JSON.parse(item.vehiculos_json);
          }
        } catch (e) {
          listaVehiculos = [];
        }

        // Filtramos valores nulos o vacíos del array de fotos
        listaFotos = listaFotos.filter((f) => f && f !== "null" && f !== "");

        return {
          ...item,
          fecha_evento: item.fecha_evento || "S/F",
          fecha_reporte: item.fecha_reporte || "S/F",
          
          placa_con_tipo: listaVehiculos.length > 0 ? listaVehiculos.join(", ") : "Sin dato",
          vehiculos: listaVehiculos,
          camaras: listaCamaras,
          
          total_fotos: listaFotos.length,
          tiene_fotos: listaFotos.length > 0,
          foto_principal: listaFotos[0] || null,
          fotos: listaFotos,
          lista_fotos: listaFotos
        };
      });

    res.json({
      success: true,
      total: totalRegistros,
      paginaActual: page,
      registrosPorPagina: limit,
      data: datosMapeados,
    });

  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/tablasipcop-rango:", error);
    res.status(500).json({ success: false, total: 0, data: [] });
  } finally {
    if (connection) connection.release();
  }
});



app.get("/ocurrencias/listar/exportarformatoseg", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const sql = `
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.estado_involucrados,
            o.turnr,
            ANY_VALUE(tvh.descripcion) AS vehiculo_tipo,
            ANY_VALUE(spf.placa) AS vehiculo_placa,
            o.estado,
            ANY_VALUE(cgen.nombre) AS cat_generica_nombre,
            ANY_VALUE(cesp.nombre) AS cat_especifica_nombre,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS coordenada,
            o.patrimonio_real,
            o.arresto_ciudadano,
            o.distancia_metros,
            ANY_VALUE(CONCAT_WS(' ', pnp.grado, pnp.nombres, pnp.apellidos)) AS pnp_nombre_completo,
            ANY_VALUE(IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                spf.placa
            )) AS placa_con_tipo,
            ANY_VALUE(ovd.tipo_asignacion) AS tipo_asignacion,
            o.codigo_seguimiento,
            ANY_VALUE(ori.descripcion) AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            ANY_VALUE(l.nombre_lugar) AS nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            ANY_VALUE(p.documento_numero) AS persona_dni,
            ANY_VALUE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres)) AS persona_nombre_completo,
            ANY_VALUE(m.nombre) AS modalidad_nombre,
            ANY_VALUE(v.nombre_via) AS via_nombre,
            ANY_VALUE(c.numero_cuadra) AS cuadra,
            ANY_VALUE(tp.nombre) AS tipo_patrullaje_nombre,
            ANY_VALUE(mp.nombre) AS mod_patrullaje_nombre,
            ANY_VALUE(l.id_lugar) AS value, 
            ANY_VALUE(CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, ''))) AS label,
            
            -- Campos de la tabla detalle_llamada_ocurrencia
            ANY_VALUE(dlo.numero_telefono) AS numero_telefono,
            ANY_VALUE(dlo.nombre_informante) AS nombre_informante,
            
            -- Descripciones unidas de SIPCOP
            ANY_VALUE(SR.descripcion) AS resultado_des,
            ANY_VALUE(SM.descripcion) AS medio_des,
            ANY_VALUE(SL.descripcion) AS lugar_des,
            ANY_VALUE(SC.descripcion) AS consecuencia_des,

            -- PNP datos (Optimizado en una sola pasada)
            pnp_agg.pnp_datos,

            -- VÍCTIMAS (Agrupadas en una sola subconsulta por tabla en lugar de 4 separadas)
            vic_agg.victimas_nombres,
            vic_agg.victimas_edades,
            vic_agg.victimas_placas,
            vic_agg.victimas_relacion,

            -- AGRESORES (Agrupados en una sola subconsulta por tabla en lugar de 3 separadas)
            agr_agg.agresores_nombres,
            agr_agg.agresores_edades,
            agr_agg.agresores_placas,

            -- fotos optimizadas
            foto_agg.foto_1,
            foto_agg.foto_2,
            foto_agg.foto_3,
            foto_agg.foto_4,
            foto_agg.total_fotos,
            foto_agg.foto_principal,

            -- Agrupación JSON para Víctimas
            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_victima', dv_sub.id_detalle_victima,
                      'nombre_victima', dv_sub.nombre_victima,
                      'placa_victima', dv_sub.placa_victima,
                      'edad', dv_sub.edad,
                      'id_relacion_v', dv_sub.id_relacion_v
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_victimas_ocurrencia dv_sub 
              WHERE dv_sub.id_ocurrencia = o.id_ocurrencia
            ) AS victimas_json,

            -- Agrupación JSON para Agresores
            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_agresor', da_sub.id_detalle_agresor,
                      'nombre_agresor', da_sub.nombre_agresor,
                      'placa_agresor', da_sub.placa_agresor,
                      'edad', da_sub.edad
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_agresores_ocurrencia da_sub 
              WHERE da_sub.id_ocurrencia = o.id_ocurrencia
            ) AS agresores_json,

            -- TODAS las fotos agrupadas en un array JSON
            (SELECT CAST(JSON_ARRAYAGG(f.url_imagen) AS CHAR) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN cat_pnp pnp ON ovd.id_pnp = pnp.id_pnp
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        LEFT JOIN cat_modalidad cmod ON o.id_modalidad = cmod.id
        LEFT JOIN cat_especifica cesp ON cmod.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real

        -- JOIN OPTIMIZADO PARA PNP
        LEFT JOIN (
            SELECT 
                id_ocurrencia,
                CASE 
                    WHEN COUNT(*) > 1 THEN GROUP_CONCAT(CONCAT('(', pos, ') ', pnp_datos) ORDER BY pos SEPARATOR '\n')
                    ELSE MAX(pnp_datos)
                END AS pnp_datos
            FROM (
                SELECT 
                    ovd.id_ocurrencia,
                    CONCAT(IFNULL(cp.apellidos, ''), ', ', IFNULL(cp.nombres, ''), ' (DNI: ', IFNULL(cp.dni, '-'), ', Grado: ', IFNULL(cp.grado, '-'), ')') AS pnp_datos,
                    ROW_NUMBER() OVER (PARTITION BY ovd.id_ocurrencia ORDER BY ovd.id_detalle) AS pos
                FROM ocurrencia_vehiculo_detalle ovd
                INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
            ) t_pnp GROUP BY id_ocurrencia
        ) pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA VÍCTIMAS (Agrupa todo en una sola pasada por ocurrencia)
        LEFT JOIN (
            SELECT 
                dv.id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(dv.nombre_victima, 'Anónimo')) ORDER BY r.pos SEPARATOR '\n') AS victimas_nombres,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(CAST(dv.edad AS CHAR), '-')) ORDER BY r.pos SEPARATOR '\n') AS victimas_edades,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(dv.placa_victima, '-')) ORDER BY r.pos SEPARATOR '\n') AS victimas_placas,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(rv.descripcion, 'SIN RELACIÓN')) ORDER BY r.pos SEPARATOR '\n') AS victimas_relacion
            FROM detalle_victimas_ocurrencia dv
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
            INNER JOIN (
                SELECT id_ocurrencia, id_detalle_victima, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos
                FROM detalle_victimas_ocurrencia
            ) r ON dv.id_ocurrencia = r.id_ocurrencia AND dv.id_detalle_victima = r.id_detalle_victima
            GROUP BY dv.id_ocurrencia
        ) vic_agg ON vic_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA AGRESORES
        LEFT JOIN (
            SELECT 
                da.id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(da.nombre_agresor, 'Desconocido')) ORDER BY r.pos SEPARATOR '\n') AS agresores_nombres,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(CAST(da.edad AS CHAR), '-')) ORDER BY r.pos SEPARATOR '\n') AS agresores_edades,
                GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(da.placa_agresor, '-')) ORDER BY r.pos SEPARATOR '\n') AS agresores_placas
            FROM detalle_agresores_ocurrencia da
            INNER JOIN (
                SELECT id_ocurrencia, id_detalle_agresor, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos
                FROM detalle_agresores_ocurrencia
            ) r ON da.id_ocurrencia = r.id_ocurrencia AND da.id_detalle_agresor = r.id_detalle_agresor
            GROUP BY da.id_ocurrencia
        ) agr_agg ON agr_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA FOTOS
        LEFT JOIN (
            SELECT 
                id_ocurrencia,
                COUNT(*) AS total_fotos,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_principal,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM (
                SELECT id_ocurrencia, url_imagen, 
                       ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_foto) AS nro
                FROM foto_ocurrencia_registro
            ) t_fotos GROUP BY id_ocurrencia
        ) foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia

        GROUP BY o.id_ocurrencia, o.fecha_reporte, o.estado, o.patrimonio_real, o.arresto_ciudadano, 
                 o.distancia_metros, o.codigo_seguimiento, o.fecha_evento, o.hora_alerta, 
                 o.hora_llegada, o.hora_repliegue, o.descripcion, o.unidad_encargada, o.referencia,
                 o.latitud_gps, o.longitud_gps, o.turnr, o.id_resultado_real, o.id_medio_real, 
                 o.id_lugar_real, o.id_consecuencia_real, o.id_origen, o.id_modalidad, o.id_tipop, o.id_modalidadp,
                 o.estado_involucrados
        ORDER BY o.fecha_reporte DESC LIMIT 1000
    `;

    const [rows] = await connection.query(sql);

    const respuesta = rows.map((item) => {
      let listaFotosUrls = [];
      let listaVictimas = [];
      let listaAgresores = [];

      try {
        listaFotosUrls = item.fotos_json ? JSON.parse(item.fotos_json) : [];
      } catch (e) {
        listaFotosUrls = [];
      }

      try {
        listaVictimas = item.victimas_json
          ? JSON.parse(item.victimas_json)
          : [];
      } catch (e) {
        listaVictimas = [];
      }

      try {
        listaAgresores = item.agresores_json
          ? JSON.parse(item.agresores_json)
          : [];
      } catch (e) {
        listaAgresores = [];
      }

      const primeraVictima = listaVictimas.length > 0 ? listaVictimas[0] : {};
      const primerAgresor = listaAgresores.length > 0 ? listaAgresores[0] : {};

      return {
        ...item,
        victimas: listaVictimas,
        agresores: listaAgresores,
        nombre_victima: primeraVictima.nombre_victima || null,
        edad_victima: primeraVictima.edad || null,
        relacion_victima: primeraVictima.id_relacion_v || null,

        nombre_agresor: primerAgresor.nombre_agresor || null,
        edad_agresor: primerAgresor.edad || null,
        placa_agresor: primerAgresor.placa_agresor || null,

        identificado:
          listaVictimas.length > 0 || listaAgresores.length > 0
            ? "IDENTIFICADO"
            : "NO_IDENTIFICADO",
        pnp_completo: item.pnp_nombre_completo || "No asignado",
        fecha_evento: item.fecha_evento
          ? new Date(item.fecha_evento).toISOString().split("T")[0]
          : "S/F",
        tiene_fotos: (item.total_fotos || 0) > 0,
        fotos: listaFotosUrls,
        lista_fotos: listaFotosUrls,
      };
    });

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/exportarformato:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/listar/exportarformatoseg1", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const sql = `
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.estado_involucrados,
            o.turnr,
            ANY_VALUE(tvh.descripcion) AS vehiculo_tipo,
            ANY_VALUE(spf.placa) AS vehiculo_placa,
            o.estado,
            ANY_VALUE(cgen.nombre) AS cat_generica_nombre,
            ANY_VALUE(cesp.nombre) AS cat_especifica_nombre,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS coordenada,
            o.patrimonio_real,
            o.arresto_ciudadano,
            o.distancia_metros,
            ANY_VALUE(CONCAT_WS(' ', pnp.grado, pnp.nombres, pnp.apellidos)) AS pnp_nombre_completo,
            ANY_VALUE(IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                spf.placa
            )) AS placa_con_tipo,
            ANY_VALUE(ovd.tipo_asignacion) AS tipo_asignacion,
            o.codigo_seguimiento,
            ANY_VALUE(ori.descripcion) AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            ANY_VALUE(l.nombre_lugar) AS nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            ANY_VALUE(p.documento_numero) AS persona_dni,
            ANY_VALUE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres)) AS persona_nombre_completo,
            ANY_VALUE(m.nombre) AS modalidad_nombre,
            ANY_VALUE(v.nombre_via) AS via_nombre,
            ANY_VALUE(c.numero_cuadra) AS cuadra,
            ANY_VALUE(tp.nombre) AS tipo_patrullaje_nombre,
            ANY_VALUE(mp.nombre) AS mod_patrullaje_nombre,
            ANY_VALUE(l.id_lugar) AS value, 
            ANY_VALUE(CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, ''))) AS label,
            
            -- Campos de la tabla detalle_llamada_ocurrencia
            ANY_VALUE(dlo.numero_telefono) AS numero_telefono,
            ANY_VALUE(dlo.nombre_informante) AS nombre_informante,
            
            -- Descripciones unidas de SIPCOP
            ANY_VALUE(SR.descripcion) AS resultado_des,
            ANY_VALUE(SM.descripcion) AS medio_des,
            ANY_VALUE(SL.descripcion) AS lugar_des,
            ANY_VALUE(SC.descripcion) AS consecuencia_des,

            -- PNP datos (Optimizado en una sola pasada)
            pnp_agg.pnp_datos,

            -- VÍCTIMAS (Sin paréntesis si es 1, con saltos de línea)
            vic_agg.victimas_nombres,
            vic_agg.victimas_edades,
            vic_agg.victimas_placas,
            vic_agg.victimas_relacion,

            -- AGRESORES (Sin paréntesis si es 1, con saltos de línea)
            agr_agg.agresores_nombres,
            agr_agg.agresores_edades,
            agr_agg.agresores_placas,

            -- fotos optimizadas
            foto_agg.foto_1,
            foto_agg.foto_2,
            foto_agg.foto_3,
            foto_agg.foto_4,
            foto_agg.total_fotos,
            foto_agg.foto_principal,

            -- Agrupación JSON para Víctimas
            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_victima', dv_sub.id_detalle_victima,
                      'nombre_victima', dv_sub.nombre_victima,
                      'placa_victima', dv_sub.placa_victima,
                      'edad', dv_sub.edad,
                      'id_relacion_v', dv_sub.id_relacion_v
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_victimas_ocurrencia dv_sub 
              WHERE dv_sub.id_ocurrencia = o.id_ocurrencia
            ) AS victimas_json,

            -- Agrupación JSON para Agresores
            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_agresor', da_sub.id_detalle_agresor,
                      'nombre_agresor', da_sub.nombre_agresor,
                      'placa_agresor', da_sub.placa_agresor,
                      'edad', da_sub.edad
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_agresores_ocurrencia da_sub 
              WHERE da_sub.id_ocurrencia = o.id_ocurrencia
            ) AS agresores_json,

            -- TODAS las fotos agrupadas en un array JSON
            (SELECT CAST(JSON_ARRAYAGG(f.url_imagen) AS CHAR) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN cat_pnp pnp ON ovd.id_pnp = pnp.id_pnp
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        LEFT JOIN cat_modalidad cmod ON o.id_modalidad = cmod.id
        LEFT JOIN cat_especifica cesp ON cmod.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real

        -- JOIN OPTIMIZADO PARA PNP
        LEFT JOIN (
            SELECT 
                id_ocurrencia,
                CASE 
                    WHEN COUNT(*) > 1 THEN GROUP_CONCAT(CONCAT('(', pos, ') ', pnp_datos) ORDER BY pos SEPARATOR '\n')
                    ELSE MAX(pnp_datos)
                END AS pnp_datos
            FROM (
                SELECT 
                    ovd.id_ocurrencia,
                    CONCAT(IFNULL(cp.apellidos, ''), ', ', IFNULL(cp.nombres, ''), ' (DNI: ', IFNULL(cp.dni, '-'), ', Grado: ', IFNULL(cp.grado, '-'), ')') AS pnp_datos,
                    ROW_NUMBER() OVER (PARTITION BY ovd.id_ocurrencia ORDER BY ovd.id_detalle) AS pos
                FROM ocurrencia_vehiculo_detalle ovd
                INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
            ) t_pnp GROUP BY id_ocurrencia
        ) pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA VÍCTIMAS
        LEFT JOIN (
            SELECT 
                dv.id_ocurrencia,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(dv.nombre_victima, 'Anónimo')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(dv.nombre_victima, 'Anónimo'))
                END AS victimas_nombres,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(CAST(dv.edad AS CHAR), '-')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(CAST(dv.edad AS CHAR), '-'))
                END AS victimas_edades,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(dv.placa_victima, '-')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(dv.placa_victima, '-'))
                END AS victimas_placas,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(rv.descripcion, 'SIN RELACIÓN')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(rv.descripcion, 'SIN RELACIÓN'))
                END AS victimas_relacion
            FROM detalle_victimas_ocurrencia dv
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
            INNER JOIN (
                SELECT id_ocurrencia, id_detalle_victima, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos
                FROM detalle_victimas_ocurrencia
            ) r ON dv.id_ocurrencia = r.id_ocurrencia AND dv.id_detalle_victima = r.id_detalle_victima
            GROUP BY dv.id_ocurrencia
        ) vic_agg ON vic_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA AGRESORES
        LEFT JOIN (
            SELECT 
                da.id_ocurrencia,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_agresores_ocurrencia a2 WHERE a2.id_ocurrencia = da.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(da.nombre_agresor, 'Desconocido')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(da.nombre_agresor, 'Desconocido'))
                END AS agresores_nombres,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_agresores_ocurrencia a2 WHERE a2.id_ocurrencia = da.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(CAST(da.edad AS CHAR), '-')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(CAST(da.edad AS CHAR), '-'))
                END AS agresores_edades,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_agresores_ocurrencia a2 WHERE a2.id_ocurrencia = da.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(da.placa_agresor, '-')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(da.placa_agresor, '-'))
                END AS agresores_placas
            FROM detalle_agresores_ocurrencia da
            INNER JOIN (
                SELECT id_ocurrencia, id_detalle_agresor, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos
                FROM detalle_agresores_ocurrencia
            ) r ON da.id_ocurrencia = r.id_ocurrencia AND da.id_detalle_agresor = r.id_detalle_agresor
            GROUP BY da.id_ocurrencia
        ) agr_agg ON agr_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA FOTOS
        LEFT JOIN (
            SELECT 
                id_ocurrencia,
                COUNT(*) AS total_fotos,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_principal,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM (
                SELECT id_ocurrencia, url_imagen, 
                       ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_foto) AS nro
                FROM foto_ocurrencia_registro
            ) t_fotos GROUP BY id_ocurrencia
        ) foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia

        GROUP BY o.id_ocurrencia, o.fecha_reporte, o.estado, o.patrimonio_real, o.arresto_ciudadano, 
                 o.distancia_metros, o.codigo_seguimiento, o.fecha_evento, o.hora_alerta, 
                 o.hora_llegada, o.hora_repliegue, o.descripcion, o.unidad_encargada, o.referencia,
                 o.latitud_gps, o.longitud_gps, o.turnr, o.id_resultado_real, o.id_medio_real, 
                 o.id_lugar_real, o.id_consecuencia_real, o.id_origen, o.id_modalidad, o.id_tipop, o.id_modalidadp,
                 o.estado_involucrados
        ORDER BY o.fecha_reporte DESC LIMIT 1000
    `;

    const [rows] = await connection.query(sql);

    const respuesta = rows.map((item) => {
      let listaFotosUrls = [];
      let listaVictimas = [];
      let listaAgresores = [];

      try {
        listaFotosUrls = item.fotos_json ? JSON.parse(item.fotos_json) : [];
      } catch (e) {
        listaFotosUrls = [];
      }

      try {
        listaVictimas = item.victimas_json
          ? JSON.parse(item.victimas_json)
          : [];
      } catch (e) {
        listaVictimas = [];
      }

      try {
        listaAgresores = item.agresores_json
          ? JSON.parse(item.agresores_json)
          : [];
      } catch (e) {
        listaAgresores = [];
      }

      const primeraVictima = listaVictimas.length > 0 ? listaVictimas[0] : {};
      const primerAgresor = listaAgresores.length > 0 ? listaAgresores[0] : {};

      return {
        ...item,
        victimas: listaVictimas,
        agresores: listaAgresores,
        nombre_victima: primeraVictima.nombre_victima || null,
        edad_victima: primeraVictima.edad || null,
        relacion_victima: primeraVictima.id_relacion_v || null,

        nombre_agresor: primerAgresor.nombre_agresor || null,
        edad_agresor: primerAgresor.edad || null,
        placa_agresor: primerAgresor.placa_agresor || null,

        identificado:
          listaVictimas.length > 0 || listaAgresores.length > 0
            ? "IDENTIFICADO"
            : "NO_IDENTIFICADO",
        pnp_completo: item.pnp_nombre_completo || "No asignado",
        fecha_evento: item.fecha_evento
          ? new Date(item.fecha_evento).toISOString().split("T")[0]
          : "S/F",
        tiene_fotos: (item.total_fotos || 0) > 0,
        fotos: listaFotosUrls,
        lista_fotos: listaFotosUrls,
      };
    });

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/exportarformatoseg:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/listar/exportarformatoseg2", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const sql = `
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.estado_involucrados,
            o.tipo_servicio_global,
            o.turnr,
            ANY_VALUE(tvh.descripcion) AS vehiculo_tipo,
            ANY_VALUE(spf.placa) AS vehiculo_placa,
            o.estado,
            ANY_VALUE(cgen.nombre) AS cat_generica_nombre,
            ANY_VALUE(cesp.nombre) AS cat_especifica_nombre,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS coordenada,
            o.patrimonio_real,
            o.arresto_ciudadano,
            o.distancia_metros,
            ANY_VALUE(CONCAT_WS(' ', pnp.grado, pnp.nombres, pnp.apellidos)) AS pnp_nombre_completo,
            ANY_VALUE(IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                spf.placa
            )) AS placa_con_tipo,
            ANY_VALUE(ovd.tipo_asignacion) AS tipo_asignacion,
            o.codigo_seguimiento,
            ANY_VALUE(ori.descripcion) AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            ANY_VALUE(l.nombre_lugar) AS nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            ANY_VALUE(m.codigo) AS codmod, 
            ANY_VALUE(p.documento_numero) AS persona_dni,
            ANY_VALUE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres)) AS persona_nombre_completo,
            ANY_VALUE(m.nombre) AS modalidad_nombre,
            ANY_VALUE(v.nombre_via) AS via_nombre,
            ANY_VALUE(c.numero_cuadra) AS cuadra,
            ANY_VALUE(tp.nombre) AS tipo_patrullaje_nombre,
            ANY_VALUE(mp.nombre) AS mod_patrullaje_nombre,
            ANY_VALUE(l.id_lugar) AS value, 
            ANY_VALUE(CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, ''))) AS label,
            
            -- Campos de la tabla detalle_llamada_ocurrencia
            ANY_VALUE(dlo.numero_telefono) AS numero_telefono,
            ANY_VALUE(dlo.nombre_informante) AS nombre_informante,
            
            -- Descripciones unidas de SIPCOP
            ANY_VALUE(SR.descripcion) AS resultado_des,
            ANY_VALUE(SM.descripcion) AS medio_des,
            ANY_VALUE(SL.descripcion) AS lugar_des,
            ANY_VALUE(SC.descripcion) AS consecuencia_des,

            -- PNP datos (Optimizado en una sola pasada)
            pnp_agg.pnp_datos,

            -- VÍCTIMAS (Sin paréntesis si es 1, con saltos de línea)
            vic_agg.victimas_nombres,
            vic_agg.victimas_edades,
            vic_agg.victimas_placas,
            vic_agg.victimas_relacion,

            -- AGRESORES (Sin paréntesis si es 1, con saltos de línea)
            agr_agg.agresores_nombres,
            agr_agg.agresores_edades,
            agr_agg.agresores_placas,

            -- fotos optimizadas
            foto_agg.foto_1,
            foto_agg.foto_2,
            foto_agg.foto_3,
            foto_agg.foto_4,
            foto_agg.total_fotos,
            foto_agg.foto_principal,

            -- Agrupación JSON para Víctimas
            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_victima', dv_sub.id_detalle_victima,
                      'nombre_victima', dv_sub.nombre_victima,
                      'placa_victima', dv_sub.placa_victima,
                      'edad', dv_sub.edad,
                      'id_relacion_v', dv_sub.id_relacion_v
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_victimas_ocurrencia dv_sub 
              WHERE dv_sub.id_ocurrencia = o.id_ocurrencia
            ) AS victimas_json,

            -- Agrupación JSON para Agresores
            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_agresor', da_sub.id_detalle_agresor,
                      'nombre_agresor', da_sub.nombre_agresor,
                      'placa_agresor', da_sub.placa_agresor,
                      'edad', da_sub.edad
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_agresores_ocurrencia da_sub 
              WHERE da_sub.id_ocurrencia = o.id_ocurrencia
            ) AS agresores_json,

            -- TODAS las fotos agrupadas en un array JSON
            (SELECT CAST(JSON_ARRAYAGG(f.url_imagen) AS CHAR) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN cat_pnp pnp ON ovd.id_pnp = pnp.id_pnp
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        LEFT JOIN cat_modalidad cmod ON o.id_modalidad = cmod.id
        LEFT JOIN cat_especifica cesp ON cmod.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real

        -- JOIN OPTIMIZADO PARA PNP
        LEFT JOIN (
            SELECT 
                id_ocurrencia,
                CASE 
                    WHEN COUNT(*) > 1 THEN GROUP_CONCAT(CONCAT('(', pos, ') ', pnp_datos) ORDER BY pos SEPARATOR '\n')
                    ELSE MAX(pnp_datos)
                END AS pnp_datos
            FROM (
                SELECT 
                    ovd.id_ocurrencia,
                    CONCAT(IFNULL(cp.apellidos, ''), ', ', IFNULL(cp.nombres, ''), ' (DNI: ', IFNULL(cp.dni, '-'), ', Grado: ', IFNULL(cp.grado, '-'), ')') AS pnp_datos,
                    ROW_NUMBER() OVER (PARTITION BY ovd.id_ocurrencia ORDER BY ovd.id_detalle) AS pos
                FROM ocurrencia_vehiculo_detalle ovd
                INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
            ) t_pnp GROUP BY id_ocurrencia
        ) pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA VÍCTIMAS
        LEFT JOIN (
            SELECT 
                dv.id_ocurrencia,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(dv.nombre_victima, 'NO IDENTIFICADO')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(dv.nombre_victima, 'NO IDENTIFICADO'))
                END AS victimas_nombres,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(CAST(dv.edad AS CHAR), '')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(CAST(dv.edad AS CHAR), ''))
                END AS victimas_edades,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(dv.placa_victima, '')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(dv.placa_victima, ''))
                END AS victimas_placas,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_victimas_ocurrencia v2 WHERE v2.id_ocurrencia = dv.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(rv.descripcion, 'SIN RELACIÓN')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(rv.descripcion, 'SIN RELACIÓN'))
                END AS victimas_relacion
            FROM detalle_victimas_ocurrencia dv
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
            INNER JOIN (
                SELECT id_ocurrencia, id_detalle_victima, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos
                FROM detalle_victimas_ocurrencia
            ) r ON dv.id_ocurrencia = r.id_ocurrencia AND dv.id_detalle_victima = r.id_detalle_victima
            GROUP BY dv.id_ocurrencia
        ) vic_agg ON vic_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA AGRESORES
        LEFT JOIN (
            SELECT 
                da.id_ocurrencia,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_agresores_ocurrencia a2 WHERE a2.id_ocurrencia = da.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(da.nombre_agresor, 'NO IDENTIFICADO')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(da.nombre_agresor, 'NO IDENTIFICADO'))
                END AS agresores_nombres,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_agresores_ocurrencia a2 WHERE a2.id_ocurrencia = da.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(CAST(da.edad AS CHAR), '')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(CAST(da.edad AS CHAR), ''))
                END AS agresores_edades,
                CASE 
                    WHEN (SELECT COUNT(*) FROM detalle_agresores_ocurrencia a2 WHERE a2.id_ocurrencia = da.id_ocurrencia) > 1 
                    THEN GROUP_CONCAT(CONCAT('(', r.pos, ') ', IFNULL(da.placa_agresor, '')) ORDER BY r.pos SEPARATOR '\n')
                    ELSE MAX(IFNULL(da.placa_agresor, ''))
                END AS agresores_placas
            FROM detalle_agresores_ocurrencia da
            INNER JOIN (
                SELECT id_ocurrencia, id_detalle_agresor, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos
                FROM detalle_agresores_ocurrencia
            ) r ON da.id_ocurrencia = r.id_ocurrencia AND da.id_detalle_agresor = r.id_detalle_agresor
            GROUP BY da.id_ocurrencia
        ) agr_agg ON agr_agg.id_ocurrencia = o.id_ocurrencia

        -- JOIN OPTIMIZADO PARA FOTOS
        LEFT JOIN (
            SELECT 
                id_ocurrencia,
                COUNT(*) AS total_fotos,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_principal,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM (
                SELECT id_ocurrencia, url_imagen, 
                       ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_foto) AS nro
                FROM foto_ocurrencia_registro
            ) t_fotos GROUP BY id_ocurrencia
        ) foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia

        GROUP BY o.id_ocurrencia, o.fecha_reporte, o.estado, o.patrimonio_real, o.arresto_ciudadano, 
                 o.distancia_metros, o.codigo_seguimiento, o.fecha_evento, o.hora_alerta, 
                 o.hora_llegada, o.hora_repliegue, o.descripcion, o.unidad_encargada, o.referencia,
                 o.latitud_gps, o.longitud_gps, o.turnr, o.id_resultado_real, o.id_medio_real, 
                 o.id_lugar_real, o.id_consecuencia_real, o.id_origen, o.id_modalidad, o.id_tipop, o.id_modalidadp,
                 o.estado_involucrados
        ORDER BY o.fecha_reporte DESC LIMIT 1000
    `;

    const [rows] = await connection.query(sql);

    const respuesta = rows.map((item) => {
      let listaFotosUrls = [];
      let listaVictimas = [];
      let listaAgresores = [];

      try {
        listaFotosUrls = item.fotos_json ? JSON.parse(item.fotos_json) : [];
      } catch (e) {
        listaFotosUrls = [];
      }

      try {
        listaVictimas = item.victimas_json
          ? JSON.parse(item.victimas_json)
          : [];
      } catch (e) {
        listaVictimas = [];
      }

      try {
        listaAgresores = item.agresores_json
          ? JSON.parse(item.agresores_json)
          : [];
      } catch (e) {
        listaAgresores = [];
      }

      const primeraVictima = listaVictimas.length > 0 ? listaVictimas[0] : {};
      const primerAgresor = listaAgresores.length > 0 ? listaAgresores[0] : {};

      return {
        ...item,
        victimas: listaVictimas,
        agresores: listaAgresores,
        nombre_victima: primeraVictima.nombre_victima || null,
        edad_victima: primeraVictima.edad || null,
        relacion_victima: primeraVictima.id_relacion_v || null,

        nombre_agresor: primerAgresor.nombre_agresor || null,
        edad_agresor: primerAgresor.edad || null,
        placa_agresor: primerAgresor.placa_agresor || null,

        identificado:
          listaVictimas.length > 0 || listaAgresores.length > 0
            ? "IDENTIFICADO"
            : "NO_IDENTIFICADO",
        pnp_completo: item.pnp_nombre_completo || "No asignado",
        fecha_evento: item.fecha_evento
          ? new Date(item.fecha_evento).toISOString().split("T")[0]
          : "S/F",
        tiene_fotos: (item.total_fotos || 0) > 0,
        fotos: listaFotosUrls,
        lista_fotos: listaFotosUrls,
      };
    });

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/exportarformatoseg:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/listar/exportarformato", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const sql = `
        WITH pnp_base AS (
            SELECT ovd.id_ocurrencia, ovd.id_detalle, cp.apellidos, cp.nombres, cp.dni, cp.grado
            FROM ocurrencia_vehiculo_detalle ovd
            INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
        ),
        pnp_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle) AS pos,
                CONCAT('(', ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle), ') ', CONCAT(IFNULL(apellidos, ''), ', ', IFNULL(nombres, ''), ' (DNI: ', IFNULL(dni, '-'), ', Grado: ', IFNULL(grado, '-'), ')')) AS texto_pnp
            FROM pnp_base
        ),
        pnp_agg AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(texto_pnp ORDER BY pos SEPARATOR '\n') AS pnp_datos
            FROM pnp_numbered
            GROUP BY id_ocurrencia
        ),
        vic_base AS (
            SELECT dv.id_ocurrencia, dv.id_detalle_victima, dv.nombre_victima, dv.edad, dv.placa_victima, rv.descripcion AS rel_desc
            FROM detalle_victimas_ocurrencia dv
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
        ),
        vic_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos,
                nombre_victima, edad, placa_victima, rel_desc
            FROM vic_base
        ),
        vic_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_victima, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS victimas_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS victimas_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_victima, '')) ORDER BY pos SEPARATOR '\n') AS victimas_placas,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(rel_desc, 'SIN RELACIÓN')) ORDER BY pos SEPARATOR '\n') AS victimas_relacion
            FROM vic_numbered
            GROUP BY id_ocurrencia
        ),
        agr_base AS (
            SELECT id_ocurrencia, id_detalle_agresor, nombre_agresor, edad, placa_agresor
            FROM detalle_agresores_ocurrencia
        ),
        agr_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos,
                nombre_agresor, edad, placa_agresor
            FROM agr_base
        ),
        agr_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_agresor, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS agresores_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS agresores_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_agresor, '')) ORDER BY pos SEPARATOR '\n') AS agresores_placas
            FROM agr_numbered
            GROUP BY id_ocurrencia
        ),
        foto_base AS (
            SELECT id_ocurrencia, url_imagen, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_foto) AS nro
            FROM foto_ocurrencia_registro
        ),
        foto_agg AS (
            SELECT 
                id_ocurrencia,
                COUNT(*) AS total_fotos,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_principal,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM foto_base 
            GROUP BY id_ocurrencia
        )
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.estado_involucrados,
            o.tipo_servicio_global,
            o.turnr,
            ANY_VALUE(tvh.descripcion) AS vehiculo_tipo,
            ANY_VALUE(spf.placa) AS vehiculo_placa,
            o.estado,
            ANY_VALUE(cgen.nombre) AS cat_generica_nombre,
            ANY_VALUE(cesp.nombre) AS cat_especifica_nombre,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS coordenada,
            o.patrimonio_real,
            o.arresto_ciudadano,
            o.distancia_metros,
            ANY_VALUE(CONCAT_WS(' ', pnp.grado, pnp.nombres, pnp.apellidos)) AS pnp_nombre_completo,
            ANY_VALUE(IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                spf.placa
            )) AS placa_con_tipo,
            ANY_VALUE(ovd.tipo_asignacion) AS tipo_asignacion,
            o.codigo_seguimiento,
            ANY_VALUE(ori.descripcion) AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            ANY_VALUE(l.nombre_lugar) AS nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            ANY_VALUE(m.codigo) AS codmod, 
            ANY_VALUE(p.documento_numero) AS persona_dni,
            ANY_VALUE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres)) AS persona_nombre_completo,
            ANY_VALUE(m.nombre) AS modalidad_nombre,
            ANY_VALUE(v.nombre_via) AS via_nombre,
            ANY_VALUE(c.numero_cuadra) AS cuadra,
            ANY_VALUE(tp.nombre) AS tipo_patrullaje_nombre,
            ANY_VALUE(mp.nombre) AS mod_patrullaje_nombre,
            ANY_VALUE(l.id_lugar) AS value, 
            ANY_VALUE(CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, ''))) AS label,
            
            ANY_VALUE(dlo.numero_telefono) AS numero_telefono,
            ANY_VALUE(dlo.nombre_informante) AS nombre_informante,
            
            ANY_VALUE(SR.descripcion) AS resultado_des,
            ANY_VALUE(SM.descripcion) AS medio_des,
            ANY_VALUE(SL.descripcion) AS lugar_des,
            ANY_VALUE(SC.descripcion) AS consecuencia_des,

            pnp_agg.pnp_datos,

            v_grp.victimas_nombres,
            v_grp.victimas_edades,
            v_grp.victimas_placas,
            v_grp.victimas_relacion,

            a_grp.agresores_nombres,
            a_grp.agresores_edades,
            a_grp.agresores_placas,

            foto_agg.foto_1,
            foto_agg.foto_2,
            foto_agg.foto_3,
            foto_agg.foto_4,
            foto_agg.total_fotos,
            foto_agg.foto_principal,

            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_victima', dv_sub.id_detalle_victima,
                      'nombre_victima', dv_sub.nombre_victima,
                      'placa_victima', dv_sub.placa_victima,
                      'edad', dv_sub.edad,
                      'id_relacion_v', dv_sub.id_relacion_v
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_victimas_ocurrencia dv_sub 
              WHERE dv_sub.id_ocurrencia = o.id_ocurrencia
            ) AS victimas_json,

            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_agresor', da_sub.id_detalle_agresor,
                      'nombre_agresor', da_sub.nombre_agresor,
                      'placa_agresor', da_sub.placa_agresor,
                      'edad', da_sub.edad
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_agresores_ocurrencia da_sub 
              WHERE da_sub.id_ocurrencia = o.id_ocurrencia
            ) AS agresores_json,

            (SELECT CAST(JSON_ARRAYAGG(f.url_imagen) AS CHAR) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN cat_pnp pnp ON ovd.id_pnp = pnp.id_pnp
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        LEFT JOIN cat_modalidad cmod ON o.id_modalidad = cmod.id
        LEFT JOIN cat_especifica cesp ON cmod.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real

        LEFT JOIN pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN vic_grouped v_grp ON v_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN agr_grouped a_grp ON a_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN foto_agg foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia

        GROUP BY o.id_ocurrencia, o.fecha_reporte, o.estado, o.patrimonio_real, o.arresto_ciudadano, 
                 o.distancia_metros, o.codigo_seguimiento, o.fecha_evento, o.hora_alerta, 
                 o.hora_llegada, o.hora_repliegue, o.descripcion, o.unidad_encargada, o.referencia,
                 o.latitud_gps, o.longitud_gps, o.turnr, o.id_resultado_real, o.id_medio_real, 
                 o.id_lugar_real, o.id_consecuencia_real, o.id_origen, o.id_modalidad, o.id_tipop, o.id_modalidadp,
                 o.estado_involucrados, pnp_agg.pnp_datos, v_grp.victimas_nombres, v_grp.victimas_edades, 
                 v_grp.victimas_placas, v_grp.victimas_relacion, a_grp.agresores_nombres, a_grp.agresores_edades, 
                 a_grp.agresores_placas, foto_agg.total_fotos, foto_agg.foto_principal, foto_agg.foto_1, 
                 foto_agg.foto_2, foto_agg.foto_3, foto_agg.foto_4
        ORDER BY o.fecha_reporte DESC
    `;

    const [rows] = await connection.query(sql);

    const respuesta = rows.map((item) => {
      let listaFotosUrls = [];
      let listaVictimas = [];
      let listaAgresores = [];

      try {
        listaFotosUrls = item.fotos_json ? JSON.parse(item.fotos_json) : [];
      } catch (e) {
        listaFotosUrls = [];
      }

      try {
        listaVictimas = item.victimas_json
          ? JSON.parse(item.victimas_json)
          : [];
      } catch (e) {
        listaVictimas = [];
      }

      try {
        listaAgresores = item.agresores_json
          ? JSON.parse(item.agresores_json)
          : [];
      } catch (e) {
        listaAgresores = [];
      }

      const primeraVictima = listaVictimas.length > 0 ? listaVictimas[0] : {};
      const primerAgresor = listaAgresores.length > 0 ? listaAgresores[0] : {};

      return {
        ...item,
        victimas: listaVictimas,
        agresores: listaAgresores,
        nombre_victima: primeraVictima.nombre_victima || null,
        edad_victima: primeraVictima.edad || null,
        relacion_victima: primeraVictima.id_relacion_v || null,

        nombre_agresor: primerAgresor.nombre_agresor || null,
        edad_agresor: primerAgresor.edad || null,
        placa_agresor: primerAgresor.placa_agresor || null,

        identificado:
          listaVictimas.length > 0 || listaAgresores.length > 0
            ? "IDENTIFICADO"
            : "NO_IDENTIFICADO",
        pnp_completo: item.pnp_nombre_completo || "No asignado",
        fecha_evento: item.fecha_evento
          ? new Date(item.fecha_evento).toISOString().split("T")[0]
          : "S/F",
        tiene_fotos: (item.total_fotos || 0) > 0,
        fotos: listaFotosUrls,
        lista_fotos: listaFotosUrls,
      };
    });

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/exportarformatoseg:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get(
  "/ocurrencias/listar/exportarformatopaginacionback",
  async (req, res) => {
    let connection;
    try {
      connection = await db.getConnection();

      // Parámetros de paginación y filtros opcionales (por defecto año actual y 25 por página)
      const anio = req.query.anio || new Date().getFullYear();
      const limit = parseInt(req.query.limit) || 25;
      const page = parseInt(req.query.page) || 1;
      const offset = (page - 1) * limit;

      // A. Obtener el total de registros y el conteo por estados de forma rápida (sin joins pesados)
      const [sqlTotales] = await connection.query(
        `SELECT 
         COUNT(*) AS total_registros,
         SUM(CASE WHEN UPPER(estado) = 'PENDIENTE' THEN 1 ELSE 0 END) as c_pendiente,
         SUM(CASE WHEN UPPER(estado) = 'SIPCOP' THEN 1 ELSE 0 END) as c_sipcop,
         SUM(CASE WHEN UPPER(estado) = 'VERIFICADO' THEN 1 ELSE 0 END) as c_verificado,
         SUM(CASE WHEN UPPER(estado) = 'ANULADO' THEN 1 ELSE 0 END) as c_anulado
       FROM ocurrencia_registro 
       WHERE YEAR(fecha_reporte) = ?`,
        [anio],
      );

      const totalRegistros = sqlTotales[0]?.total_registros || 0;
      const totalPaginas = Math.ceil(totalRegistros / limit) || 1;

      const conteosEstados = {
        PENDIENTE: sqlTotales[0]?.c_pendiente || 0,
        SIPCOP: sqlTotales[0]?.c_sipcop || 0,
        VERIFICADO: sqlTotales[0]?.c_verificado || 0,
        ANULADO: sqlTotales[0]?.c_anulado || 0,
      };

      // B. Consulta principal paginada (Solo procesa los IDs de la página actual)
      const sqlPaginated = `
        WITH ocurrencias_paginadas AS (
            SELECT id_ocurrencia
            FROM ocurrencia_registro
            WHERE YEAR(fecha_reporte) = ?
            ORDER BY fecha_reporte DESC
            LIMIT ? OFFSET ?
        ),
        pnp_base AS (
            SELECT ovd.id_ocurrencia, ovd.id_detalle, cp.apellidos, cp.nombres, cp.dni, cp.grado
            FROM ocurrencia_vehiculo_detalle ovd
            INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
            INNER JOIN ocurrencias_paginadas op ON ovd.id_ocurrencia = op.id_ocurrencia
        ),
        pnp_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle) AS pos,
                CONCAT('(', ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle), ') ', CONCAT(IFNULL(apellidos, ''), ', ', IFNULL(nombres, ''), ' (DNI: ', IFNULL(dni, '-'), ', Grado: ', IFNULL(grado, '-'), ')')) AS texto_pnp
            FROM pnp_base
        ),
        pnp_agg AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(texto_pnp ORDER BY pos SEPARATOR '\n') AS pnp_datos
            FROM pnp_numbered
            GROUP BY id_ocurrencia
        ),
        vic_base AS (
            SELECT dv.id_ocurrencia, dv.id_detalle_victima, dv.nombre_victima, dv.edad, dv.placa_victima, rv.descripcion AS rel_desc
            FROM detalle_victimas_ocurrencia dv
            INNER JOIN ocurrencias_paginadas op ON dv.id_ocurrencia = op.id_ocurrencia
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
        ),
        vic_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos,
                nombre_victima, edad, placa_victima, rel_desc
            FROM vic_base
        ),
        vic_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_victima, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS victimas_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS victimas_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_victima, '')) ORDER BY pos SEPARATOR '\n') AS victimas_placas,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(rel_desc, 'SIN RELACIÓN')) ORDER BY pos SEPARATOR '\n') AS victimas_relacion
            FROM vic_numbered
            GROUP BY id_ocurrencia
        ),
        agr_base AS (
            SELECT da.id_ocurrencia, da.id_detalle_agresor, da.nombre_agresor, da.edad, da.placa_agresor
            FROM detalle_agresores_ocurrencia da
            INNER JOIN ocurrencias_paginadas op ON da.id_ocurrencia = op.id_ocurrencia
        ),
        agr_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos,
                nombre_agresor, edad, placa_agresor
            FROM agr_base
        ),
        agr_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_agresor, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS agresores_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS agresores_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_agresor, '')) ORDER BY pos SEPARATOR '\n') AS agresores_placas
            FROM agr_numbered
            GROUP BY id_ocurrencia
        ),
        foto_base AS (
            SELECT f.id_ocurrencia, f.url_imagen, ROW_NUMBER() OVER (PARTITION BY f.id_ocurrencia ORDER BY f.id_foto) AS nro
            FROM foto_ocurrencia_registro f
            INNER JOIN ocurrencias_paginadas op ON f.id_ocurrencia = op.id_ocurrencia
        ),
        foto_agg AS (
            SELECT 
                id_ocurrencia,
                COUNT(*) AS total_fotos,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_principal,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM foto_base 
            GROUP BY id_ocurrencia
        )
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.estado_involucrados,
            o.tipo_servicio_global,
            o.turnr,
            ANY_VALUE(tvh.descripcion) AS vehiculo_tipo,
            ANY_VALUE(spf.placa) AS vehiculo_placa,
            o.estado,
            ANY_VALUE(cgen.nombre) AS cat_generica_nombre,
            ANY_VALUE(cesp.nombre) AS cat_especifica_nombre,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS coordenada,
            o.patrimonio_real,
            o.arresto_ciudadano,
            o.distancia_metros,
            ANY_VALUE(CONCAT_WS(' ', pnp.grado, pnp.nombres, pnp.apellidos)) AS pnp_nombre_completo,
            ANY_VALUE(IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                spf.placa
            )) AS placa_con_tipo,
            ANY_VALUE(ovd.tipo_asignacion) AS tipo_asignacion,
            o.codigo_seguimiento,
            ANY_VALUE(ori.descripcion) AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            ANY_VALUE(l.nombre_lugar) AS nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            ANY_VALUE(m.codigo) AS codmod, 
            ANY_VALUE(p.documento_numero) AS persona_dni,
            ANY_VALUE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres)) AS persona_nombre_completo,
            ANY_VALUE(m.nombre) AS modalidad_nombre,
            ANY_VALUE(v.nombre_via) AS via_nombre,
            ANY_VALUE(c.numero_cuadra) AS cuadra,
            ANY_VALUE(tp.nombre) AS tipo_patrullaje_nombre,
            ANY_VALUE(mp.nombre) AS mod_patrullaje_nombre,
            ANY_VALUE(l.id_lugar) AS value, 
            ANY_VALUE(CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, ''))) AS label,
            ANY_VALUE(dlo.numero_telefono) AS numero_telefono,
            ANY_VALUE(dlo.nombre_informante) AS nombre_informante,
            ANY_VALUE(SR.descripcion) AS resultado_des,
            ANY_VALUE(SM.descripcion) AS medio_des,
            ANY_VALUE(SL.descripcion) AS lugar_des,
            ANY_VALUE(SC.descripcion) AS consecuencia_des,
            pnp_agg.pnp_datos,
            v_grp.victimas_nombres,
            v_grp.victimas_edades,
            v_grp.victimas_placas,
            v_grp.victimas_relacion,
            a_grp.agresores_nombres,
            a_grp.agresores_edades,
            a_grp.agresores_placas,
            foto_agg.foto_1,
            foto_agg.foto_2,
            foto_agg.foto_3,
            foto_agg.foto_4,
            foto_agg.total_fotos,
            foto_agg.foto_principal,
            (
              SELECT CAST(COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id_detalle_victima', dv_sub.id_detalle_victima, 'nombre_victima', dv_sub.nombre_victima, 'placa_victima', dv_sub.placa_victima, 'edad', dv_sub.edad, 'id_relacion_v', dv_sub.id_relacion_v)), '[]') AS CHAR) 
              FROM detalle_victimas_ocurrencia dv_sub WHERE dv_sub.id_ocurrencia = o.id_ocurrencia
            ) AS victimas_json,
            (
              SELECT CAST(COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id_detalle_agresor', da_sub.id_detalle_agresor, 'nombre_agresor', da_sub.nombre_agresor, 'placa_agresor', da_sub.placa_agresor, 'edad', da_sub.edad)), '[]') AS CHAR) 
              FROM detalle_agresores_ocurrencia da_sub WHERE da_sub.id_ocurrencia = o.id_ocurrencia
            ) AS agresores_json,
            (SELECT CAST(JSON_ARRAYAGG(f.url_imagen) AS CHAR) FROM foto_ocurrencia_registro f WHERE f.id_ocurrencia = o.id_ocurrencia) AS fotos_json
        FROM ocurrencias_paginadas op
        INNER JOIN ocurrencia_registro o ON op.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN cat_pnp pnp ON ovd.id_pnp = pnp.id_pnp
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        LEFT JOIN cat_modalidad cmod ON o.id_modalidad = cmod.id
        LEFT JOIN cat_especifica cesp ON cmod.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real
        LEFT JOIN pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN vic_grouped v_grp ON v_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN agr_grouped a_grp ON a_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN foto_agg foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia
        GROUP BY o.id_ocurrencia, o.fecha_reporte, o.estado, o.patrimonio_real, o.arresto_ciudadano, 
                 o.distancia_metros, o.codigo_seguimiento, o.fecha_evento, o.hora_alerta, 
                 o.hora_llegada, o.hora_repliegue, o.descripcion, o.unidad_encargada, o.referencia,
                 o.latitud_gps, o.longitud_gps, o.turnr, o.id_resultado_real, o.id_medio_real, 
                 o.id_lugar_real, o.id_consecuencia_real, o.id_origen, o.id_modalidad, o.id_tipop, o.id_modalidadp,
                 o.estado_involucrados, pnp_agg.pnp_datos, v_grp.victimas_nombres, v_grp.victimas_edades, 
                 v_grp.victimas_placas, v_grp.victimas_relacion, a_grp.agresores_nombres, a_grp.agresores_edades, 
                 a_grp.agresores_placas, foto_agg.total_fotos, foto_agg.foto_principal, foto_agg.foto_1, 
                 foto_agg.foto_2, foto_agg.foto_3, foto_agg.foto_4
        ORDER BY o.fecha_reporte DESC;
    `;

      const [rows] = await connection.query(sqlPaginated, [
        anio,
        limit,
        offset,
      ]);

      const respuestaMapeada = rows.map((item) => {
        let listaFotosUrls = [];
        let listaVictimas = [];
        let listaAgresores = [];

        try {
          listaFotosUrls = item.fotos_json ? JSON.parse(item.fotos_json) : [];
        } catch (e) {}
        try {
          listaVictimas = item.victimas_json
            ? JSON.parse(item.victimas_json)
            : [];
        } catch (e) {}
        try {
          listaAgresores = item.agresores_json
            ? JSON.parse(item.agresores_json)
            : [];
        } catch (e) {}

        const primeraVictima = listaVictimas[0] || {};
        const primerAgresor = listaAgresores[0] || {};

        return {
          ...item,
          victimas: listaVictimas,
          agresores: listaAgresores,
          nombre_victima: primeraVictima.nombre_victima || null,
          edad_victima: primeraVictima.edad || null,
          relacion_victima: primeraVictima.id_relacion_v || null,
          nombre_agresor: primerAgresor.nombre_agresor || null,
          edad_agresor: primerAgresor.edad || null,
          placa_agresor: primerAgresor.placa_agresor || null,
          identificado:
            listaVictimas.length > 0 || listaAgresores.length > 0
              ? "IDENTIFICADO"
              : "NO_IDENTIFICADO",
          pnp_completo: item.pnp_nombre_completo || "No asignado",
          fecha_evento: item.fecha_evento
            ? new Date(item.fecha_evento).toISOString().split("T")[0]
            : "S/F",
          tiene_fotos: (item.total_fotos || 0) > 0,
          fotos: listaFotosUrls,
          lista_fotos: listaFotosUrls,
        };
      });

      // Respuesta limpia y estructurada para el frontend
      res.json({
        success: true,
        data: respuestaMapeada,
        paginacion: {
          totalRegistros,
          totalPaginas,
          paginaActual: page,
        },
        conteosEstados,
      });
    } catch (error) {
      console.error("ERROR EN /ocurrencias/listar/exportarformato:", error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) connection.release();
    }
  },
);

app.get("/ocurrencias/listar/exportarango", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // 1. Capturamos las fechas desde los query params (ej. ?inicio=2026-08-01&fin=2026-09-02)
    let { inicio, fin } = req.query;

    // 2. Si no se envían fechas, por defecto asignamos el mes en curso (ej. del 1 de este mes hasta el 2 del siguiente)
    if (!inicio || !fin) {
      const fechaActual = new Date();
      const anio = fechaActual.getFullYear();
      const mes = String(fechaActual.getMonth() + 1).padStart(2, "0");

      inicio = `${anio}-${mes}-01`;

      // Calculamos el inicio del próximo mes + 2 días para cubrir completamente el rango que necesitas
      const siguienteMes = new Date(anio, fechaActual.getMonth() + 1, 1);
      const anioSig = siguienteMes.getFullYear();
      const mesSig = String(siguienteMes.getMonth() + 1).padStart(2, "0");
      fin = `${anioSig}-${mesSig}-02`;
    }

    const sql = `
        WITH pnp_base AS (
            SELECT ovd.id_ocurrencia, ovd.id_detalle, cp.apellidos, cp.nombres, cp.dni, cp.grado
            FROM ocurrencia_vehiculo_detalle ovd
            INNER JOIN cat_pnp cp ON ovd.id_pnp = cp.id_pnp
        ),
        pnp_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle) AS pos,
                CONCAT('(', ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle), ') ', CONCAT(IFNULL(apellidos, ''), ', ', IFNULL(nombres, ''), ' (DNI: ', IFNULL(dni, '-'), ', Grado: ', IFNULL(grado, '-'), ')')) AS texto_pnp
            FROM pnp_base
        ),
        pnp_agg AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(texto_pnp ORDER BY pos SEPARATOR '\n') AS pnp_datos
            FROM pnp_numbered
            GROUP BY id_ocurrencia
        ),
        vic_base AS (
            SELECT dv.id_ocurrencia, dv.id_detalle_victima, dv.nombre_victima, dv.edad, dv.placa_victima, rv.descripcion AS rel_desc
            FROM detalle_victimas_ocurrencia dv
            LEFT JOIN sipcop_relacion_v rv ON dv.id_relacion_v = rv.id_relacion_v
        ),
        vic_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_victima) AS pos,
                nombre_victima, edad, placa_victima, rel_desc
            FROM vic_base
        ),
        vic_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_victima, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS victimas_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS victimas_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_victima, '')) ORDER BY pos SEPARATOR '\n') AS victimas_placas,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(rel_desc, 'SIN RELACIÓN')) ORDER BY pos SEPARATOR '\n') AS victimas_relacion
            FROM vic_numbered
            GROUP BY id_ocurrencia
        ),
        agr_base AS (
            SELECT id_ocurrencia, id_detalle_agresor, nombre_agresor, edad, placa_agresor
            FROM detalle_agresores_ocurrencia
        ),
        agr_numbered AS (
            SELECT 
                id_ocurrencia,
                ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_detalle_agresor) AS pos,
                nombre_agresor, edad, placa_agresor
            FROM agr_base
        ),
        agr_grouped AS (
            SELECT 
                id_ocurrencia,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(nombre_agresor, 'NO IDENTIFICADO')) ORDER BY pos SEPARATOR '\n') AS agresores_nombres,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(CAST(edad AS CHAR), '')) ORDER BY pos SEPARATOR '\n') AS agresores_edades,
                GROUP_CONCAT(CONCAT('(', pos, ') ', IFNULL(placa_agresor, '')) ORDER BY pos SEPARATOR '\n') AS agresores_placas
            FROM agr_numbered
            GROUP BY id_ocurrencia
        ),
        foto_base AS (
            SELECT id_ocurrencia, url_imagen, ROW_NUMBER() OVER (PARTITION BY id_ocurrencia ORDER BY id_foto) AS nro
            FROM foto_ocurrencia_registro
        ),
        foto_agg AS (
            SELECT 
                id_ocurrencia,
                COUNT(*) AS total_fotos,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_principal,
                MAX(CASE WHEN nro = 1 THEN url_imagen END) AS foto_1,
                MAX(CASE WHEN nro = 2 THEN url_imagen END) AS foto_2,
                MAX(CASE WHEN nro = 3 THEN url_imagen END) AS foto_3,
                MAX(CASE WHEN nro = 4 THEN url_imagen END) AS foto_4
            FROM foto_base 
            GROUP BY id_ocurrencia
        )
        SELECT 
            o.id_ocurrencia,
            o.fecha_reporte,
            o.estado_involucrados,
            o.tipo_servicio_global,
            o.turnr,
            ANY_VALUE(tvh.descripcion) AS vehiculo_tipo,
            ANY_VALUE(spf.placa) AS vehiculo_placa,
            o.estado,
            ANY_VALUE(cgen.nombre) AS cat_generica_nombre,
            ANY_VALUE(cesp.nombre) AS cat_especifica_nombre,
            CONCAT(o.latitud_gps, ' ', o.longitud_gps) AS coordenada,
            o.patrimonio_real,
            o.arresto_ciudadano,
            o.distancia_metros,
            ANY_VALUE(CONCAT_WS(' ', pnp.grado, pnp.nombres, pnp.apellidos)) AS pnp_nombre_completo,
            ANY_VALUE(IF(tvh.descripcion IS NOT NULL AND tvh.descripcion != '', 
                CONCAT(spf.placa, ' (', tvh.descripcion, ')'), 
                spf.placa
            )) AS placa_con_tipo,
            ANY_VALUE(ovd.tipo_asignacion) AS tipo_asignacion,
            o.codigo_seguimiento,
            ANY_VALUE(ori.descripcion) AS origen_descripcion,
            o.fecha_evento,
            o.hora_alerta,
            o.hora_llegada,
            o.hora_repliegue,
            o.descripcion AS ocurrencia_descripcion,
            ANY_VALUE(l.nombre_lugar) AS nombre_lugar,
            o.unidad_encargada,
            o.referencia,
            ANY_VALUE(m.codigo) AS codmod, 
            ANY_VALUE(p.documento_numero) AS persona_dni,
            ANY_VALUE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres)) AS persona_nombre_completo,
            ANY_VALUE(m.nombre) AS modalidad_nombre,
            ANY_VALUE(v.nombre_via) AS via_nombre,
            ANY_VALUE(c.numero_cuadra) AS cuadra,
            ANY_VALUE(tp.nombre) AS tipo_patrullaje_nombre,
            ANY_VALUE(mp.nombre) AS mod_patrullaje_nombre,
            ANY_VALUE(l.id_lugar) AS value, 
            ANY_VALUE(CONCAT(COALESCE(tv.abreviatura, ''), ' ', COALESCE(v.nombre_via, ''), ' CDRA. ', COALESCE(c.numero_cuadra, ''))) AS label,
            
            ANY_VALUE(dlo.numero_telefono) AS numero_telefono,
            ANY_VALUE(dlo.nombre_informante) AS nombre_informante,
            
            ANY_VALUE(SR.descripcion) AS resultado_des,
            ANY_VALUE(SM.descripcion) AS medio_des,
            ANY_VALUE(SL.descripcion) AS lugar_des,
            ANY_VALUE(SC.descripcion) AS consecuencia_des,

            pnp_agg.pnp_datos,

            v_grp.victimas_nombres,
            v_grp.victimas_edades,
            v_grp.victimas_placas,
            v_grp.victimas_relacion,

            a_grp.agresores_nombres,
            a_grp.agresores_edades,
            a_grp.agresores_placas,

            foto_agg.foto_1,
            foto_agg.foto_2,
            foto_agg.foto_3,
            foto_agg.foto_4,
            foto_agg.total_fotos,
            foto_agg.foto_principal,

            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_victima', dv_sub.id_detalle_victima,
                      'nombre_victima', dv_sub.nombre_victima,
                      'placa_victima', dv_sub.placa_victima,
                      'edad', dv_sub.edad,
                      'id_relacion_v', dv_sub.id_relacion_v
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_victimas_ocurrencia dv_sub 
              WHERE dv_sub.id_ocurrencia = o.id_ocurrencia
            ) AS victimas_json,

            (
              SELECT CAST(
                COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id_detalle_agresor', da_sub.id_detalle_agresor,
                      'nombre_agresor', da_sub.nombre_agresor,
                      'placa_agresor', da_sub.placa_agresor,
                      'edad', da_sub.edad
                    )
                  ), 
                  '[]'
                ) AS CHAR
              ) 
              FROM detalle_agresores_ocurrencia da_sub 
              WHERE da_sub.id_ocurrencia = o.id_ocurrencia
            ) AS agresores_json,

            (SELECT CAST(JSON_ARRAYAGG(f.url_imagen) AS CHAR) 
             FROM foto_ocurrencia_registro f 
             WHERE f.id_ocurrencia = o.id_ocurrencia) AS fotos_json

        FROM ocurrencia_registro o
        LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
        LEFT JOIN persona p ON us.id_persona = p.id_persona
        LEFT JOIN lugar l ON o.id_lugar = l.id_lugar
        LEFT JOIN via v ON l.id_via = v.id_via
        LEFT JOIN cuadra c ON l.id_cuadra = c.id_cuadra
        LEFT JOIN tipo_via tv ON v.id_tipo_via = tv.id_tipo_via
        INNER JOIN origen ori ON o.id_origen = ori.id_origen 
        LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
        LEFT JOIN ocurrencia_vehiculo_detalle ovd ON ovd.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN sipcop_flota_municipal spf ON spf.id_unidad = ovd.id_unidad
        LEFT JOIN tipo_vehiculo tvh ON ovd.id_tipo_vehiculo = tvh.id_tipo_vehiculo
        LEFT JOIN cat_pnp pnp ON ovd.id_pnp = pnp.id_pnp
        LEFT JOIN tipo_patrullaje tp ON o.id_tipop = tp.id_tipop
        LEFT JOIN modalidad_patrullaje mp ON o.id_modalidadp = mp.id_modalidadp
        LEFT JOIN detalle_llamada_ocurrencia dlo ON o.id_ocurrencia = dlo.id_ocurrencia
        LEFT JOIN cat_modalidad cmod ON o.id_modalidad = cmod.id
        LEFT JOIN cat_especifica cesp ON cmod.especifica_id = cesp.id
        LEFT JOIN cat_generica cgen ON cesp.generica_id = cgen.id
        LEFT JOIN sipcop_resultado SR ON SR.id_resultado = o.id_resultado_real
        LEFT JOIN sipcop_medio SM ON SM.id_medio = o.id_medio_real
        LEFT JOIN sipcop_lugar SL ON SL.id_lugarsip = o.id_lugar_real
        LEFT JOIN sipcop_consecuencia SC ON SC.id_consecuencia = o.id_consecuencia_real

        LEFT JOIN pnp_agg ON pnp_agg.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN vic_grouped v_grp ON v_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN agr_grouped a_grp ON a_grp.id_ocurrencia = o.id_ocurrencia
        LEFT JOIN foto_agg foto_agg ON foto_agg.id_ocurrencia = o.id_ocurrencia

        -- 🛑 FILTRO DE FECHAS PARA PROTEGER LA BASE DE DATOS
        WHERE o.fecha_evento BETWEEN ? AND ?

        GROUP BY o.id_ocurrencia, o.fecha_reporte, o.estado, o.patrimonio_real, o.arresto_ciudadano, 
                 o.distancia_metros, o.codigo_seguimiento, o.fecha_evento, o.hora_alerta, 
                 o.hora_llegada, o.hora_repliegue, o.descripcion, o.unidad_encargada, o.referencia,
                 o.latitud_gps, o.longitud_gps, o.turnr, o.id_resultado_real, o.id_medio_real, 
                 o.id_lugar_real, o.id_consecuencia_real, o.id_origen, o.id_modalidad, o.id_tipop, o.id_modalidadp,
                 o.estado_involucrados, pnp_agg.pnp_datos, v_grp.victimas_nombres, v_grp.victimas_edades, 
                 v_grp.victimas_placas, v_grp.victimas_relacion, a_grp.agresores_nombres, a_grp.agresores_edades, 
                 a_grp.agresores_placas, foto_agg.total_fotos, foto_agg.foto_principal, foto_agg.foto_1, 
                 foto_agg.foto_2, foto_agg.foto_3, foto_agg.foto_4
        ORDER BY o.fecha_reporte DESC
    `;

    // 3. Pasamos las variables de inicio y fin protegidas contra inyección SQL
    const [rows] = await connection.query(sql, [inicio, fin]);

    const respuesta = rows.map((item) => {
      let listaFotosUrls = [];
      let listaVictimas = [];
      let listaAgresores = [];

      try {
        listaFotosUrls = item.fotos_json ? JSON.parse(item.fotos_json) : [];
      } catch (e) {
        listaFotosUrls = [];
      }

      try {
        listaVictimas = item.victimas_json
          ? JSON.parse(item.victimas_json)
          : [];
      } catch (e) {
        listaVictimas = [];
      }

      try {
        listaAgresores = item.agresores_json
          ? JSON.parse(item.agresores_json)
          : [];
      } catch (e) {
        listaAgresores = [];
      }

      const primeraVictima = listaVictimas.length > 0 ? listaVictimas[0] : {};
      const primerAgresor = listaAgresores.length > 0 ? listaAgresores[0] : {};

      return {
        ...item,
        victimas: listaVictimas,
        agresores: listaAgresores,
        nombre_victima: primeraVictima.nombre_victima || null,
        edad_victima: primeraVictima.edad || null,
        relacion_victima: primeraVictima.id_relacion_v || null,

        nombre_agresor: primerAgresor.nombre_agresor || null,
        edad_agresor: primerAgresor.edad || null,
        placa_agresor: primerAgresor.placa_agresor || null,

        identificado:
          listaVictimas.length > 0 || listaAgresores.length > 0
            ? "IDENTIFICADO"
            : "NO_IDENTIFICADO",
        pnp_completo: item.pnp_nombre_completo || "No asignado",
        fecha_evento: item.fecha_evento
          ? new Date(item.fecha_evento).toISOString().split("T")[0]
          : "S/F",
        tiene_fotos: (item.total_fotos || 0) > 0,
        fotos: listaFotosUrls,
        lista_fotos: listaFotosUrls,
      };
    });

    res.json(respuesta);
  } catch (error) {
    console.error("ERROR EN /ocurrencias/listar/exportarformato:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
// Endpoint Integrado: Apertura de Turno con Odómetro y Checklist Obligatorio
app.post("/api/vehiculo/iniciar-servicio-checklist", async (req, res) => {
  const {
    id_ocurrencia,
    id_tipo_vehiculo,
    id_unidad,
    odometro_inicial,
    checklist,
  } = req.body;
  // Estructura esperada de 'checklist': [{ id_item: 1, esta_conforme: 1, observacion: '' }, ...]

  // Validaciones estrictas de inicio
  if (!odometro_inicial) {
    return res.status(400).json({
      error: "El odómetro inicial es requerido para iniciar la guardia.",
    });
  }
  if (!checklist || checklist.length === 0) {
    return res.status(400).json({
      error: "Debe completar el checklist de conformidad física de la unidad.",
    });
  }

  const connection = await db.getConnection();
  try {
    // Iniciamos una transacción atómica para proteger la consistencia de los datos
    await connection.beginTransaction();

    // 1. Registrar la apertura del uso del vehículo (Activa el Trigger de control horario)
    const queryDetalle = `
            INSERT INTO ocurrencia_vehiculo_detalle (id_ocurrencia, id_tipo_vehiculo, id_unidad, odometro_inicial)
            VALUES (?, ?, ?, ?)
        `;
    const [resultDetalle] = await connection.execute(queryDetalle, [
      id_ocurrencia,
      id_tipo_vehiculo,
      id_unidad,
      odometro_inicial,
    ]);
    const id_detalle = resultDetalle.insertId;

    // 2. Procesar el Checklist de conformidad recibido desde el dispositivo móvil
    const queryChecklist = `
            INSERT INTO ocurrencia_vehiculo_checklist (id_detalle, id_item, esta_conforme, observacion)
            VALUES (?, ?, ?, ?)
        `;

    let unidad_con_fallas = false;

    for (const item of checklist) {
      if (item.esta_conforme === 0) {
        unidad_con_fallas = true;
      }
      await connection.execute(queryChecklist, [
        id_detalle,
        item.id_item,
        item.esta_conforme,
        item.observacion || null,
      ]);
    }

    // 3. Evaluar el estado según las condiciones de la unidad recibida
    if (unidad_con_fallas) {
      // Marcamos este nuevo inicio como OBSERVADO
      await connection.execute(
        `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'OBSERVADO' WHERE id_detalle = ?`,
        [id_detalle],
      );

      // Forzamos el cierre del turno anterior como PENDIENTE_AUDITORIA para deslindar responsabilidades por daños
      const queryAuditarAnterior = `
                UPDATE ocurrencia_vehiculo_detalle 
                SET estado_cierre = 'PENDIENTE_AUDITORIA' 
                WHERE id_unidad = ? AND id_detalle != ?
                ORDER BY fecha_asignacion DESC LIMIT 1
            `;
      await connection.execute(queryAuditarAnterior, [id_unidad, id_detalle]);
    }

    // Si todo marchó bien, guardamos definitivamente en la BD
    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Apertura de servicio y checklist guardados exitosamente.",
      id_detalle,
      alerta_auditoria: unidad_con_fallas,
    });
  } catch (error) {
    // En caso de cualquier error en el bucle o inserción, revertimos todo para evitar registros huérfanos
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

//mas integrado falta checjkit solo esta odometro
app.post("/api/vehiculo/iniciar-servicio-checklists", async (req, res) => {
  let connection;
  let uploadedPublicIds = []; // Control para revertir subidas a Cloudinary si hay rollback

  try {
    console.log(
      "📩 PETICIÓN RECIBIDA (Checklist + Ocurrencia Step 1):",
      req.body,
    );

    const {
      // Datos del Step 1 / Ocurrencia Principal
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      vehiculos_detalle,
      id_personal_ids, // Array de IDs de personal de apoyo
      detalle_llamada, // Objeto: { numero_telefono, nombre_informante }
      agresores_detalle, // Array de objetos de agresores
      victimas_detalle, // Array de objetos de víctimas

      // NOTA: Si manejas campos adicionales del Checklist (ej. kilometraje, nivel_combustible, etc.),
      // agrégalos aquí abajo para utilizarlos en sus respectivas tablas si es necesario.
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // ==========================================
    // 1. INSERTAR OCURRENCIA PRINCIPAL
    // ==========================================
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;
    console.log(`✨ Ocurrencia registrada con ID: ${id_nueva_ocurrencia}`);

    // ==========================================
    // 2. INSERTAR DETALLE DE CÁMARAS
    // ==========================================
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
        console.log(`🎥 ${idsCamLimpios.length} cámaras vinculadas.`);
      }
    }

    // ==========================================
    // 3. INSERTAR PERSONAL DE APOYO
    // ==========================================
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsPersLimpios.length > 0) {
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
        console.log(`👮 ${idsPersLimpios.length} agentes de apoyo vinculados.`);
      }
    }

    // ==========================================
    // 4. INSERTAR VEHÍCULOS DEL DETALLE
    // ==========================================
    // ==========================================
    // 4. INSERTAR VEHÍCULOS DEL DETALLE + AUDITORÍA DE RELEVO
    // ==========================================
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      for (const v of vehiculos_detalle) {
        const id_unidad = v.id_unidad;
        const odometro_inicial = v.odometro_inicial
          ? parseInt(v.odometro_inicial)
          : 0;
        const id_tipo_vehiculo = v.id_tipo_vehiculo || 2; // Por defecto 2 (Camioneta)

        // ─── A. CALCULAR EL TURNO EN TIEMPO REAL (REEMPLAZO DEL TRIGGER) ───
        const ahora = new Date();
        const hora_actual = ahora.toTimeString().split(" ")[0]; // Formato "HH:MM:SS"
        let turno_calculado = "NOCHE";

        if (id_tipo_vehiculo === 1) {
          // MOTOCICLETA
          if (hora_actual >= "05:30:00" && hora_actual < "13:30:00")
            turno_calculado = "MAÑANA";
          else if (hora_actual >= "13:30:00" && hora_actual < "20:30:00")
            turno_calculado = "TARDE";
        } else {
          // CAMIONETA O SCOOTER
          if (hora_actual >= "06:30:00" && hora_actual < "14:30:00")
            turno_calculado = "MAÑANA";
          else if (hora_actual >= "14:30:00" && hora_actual < "21:30:00")
            turno_calculado = "TARDE";
        }

        // ─── B. BUSCAR REGISTRO ANTERIOR ABIERTO (REEMPLAZO DEL TRIGGER) ───
        const sqlBuscarAnt = `
            SELECT id_detalle, odometro_inicial, fecha_asignacion 
            FROM ocurrencia_vehiculo_detalle
            WHERE id_unidad = ? AND odometro_final IS NULL
            ORDER BY fecha_asignacion DESC LIMIT 1`;

        const [registrosAnt] = await connection.query(sqlBuscarAnt, [
          id_unidad,
        ]);

        if (registrosAnt.length > 0) {
          const ant = registrosAnt[0];
          const fecha_ant = new Date(ant.fecha_asignacion);
          const horas_transcurridas = Math.abs(ahora - fecha_ant) / 36e5; // Diferencia en horas flotantes

          // Si está dentro del rango normal de relevo continuo (<= 10 horas)
          if (horas_transcurridas <= 10) {
            if (odometro_inicial >= ant.odometro_inicial) {
              // Kilometraje coherente -> Se cierra el servicio anterior limpio
              await connection.query(
                `UPDATE ocurrencia_vehiculo_detalle SET odometro_final = ?, estado_cierre = 'REGISTRADO' WHERE id_detalle = ?`,
                [odometro_inicial, ant.id_detalle],
              );
            } else {
              // Alerta kilometraje menor -> Pasa a revisión de auditoría
              await connection.query(
                `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
                [ant.id_detalle],
              );
            }
          } else {
            // Pasaron más de 10 horas -> Se le olvidó cerrar turno
            await connection.query(
              `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
              [ant.id_detalle],
            );
          }
        }

        // ─── C. INSERTAR EL NUEVO REGISTRO LIMPIO DE FORMA SEGURA ───
        await connection.query(
          `INSERT INTO ocurrencia_vehiculo_detalle 
            (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp, odometro_inicial, fecha_asignacion) 
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [
            id_nueva_ocurrencia,
            id_tipo_vehiculo,
            id_unidad,
            turno_calculado,
            v.id_pnp || null,
            odometro_inicial,
          ],
        );
      }
      console.log(
        `🚗 ${vehiculos_detalle.length} vehículos procesados y auditados desde Node.js con éxito.`,
      );
    }

    // ==========================================
    // 5. PROCESAR SUBIDA DE FOTOS A CLOUDINARY
    // ==========================================
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) => {
          const fileStr = f.base64_data.startsWith("data:")
            ? f.base64_data
            : `data:image/jpeg;base64,${f.base64_data}`;

          return cloudinary.uploader
            .upload(fileStr, {
              upload_preset: "renderizado",
              chunk_size: 6000000, // Bloques de 6MB para archivos pesados
            })
            .catch((err) => {
              console.error(
                "❌ Error subiendo una foto individual a Cloudinary:",
                err.message,
              );
              return null;
            });
        });

      const uploadResultsRaw = await Promise.all(uploadPromises);
      const uploadResults = uploadResultsRaw.filter((r) => r !== null);

      if (uploadResults.length > 0) {
        uploadedPublicIds = uploadResults.map((r) => r.public_id);

        const photoValues = uploadResults.map((r) => [
          id_nueva_ocurrencia,
          r.secure_url,
          r.public_id,
        ]);

        await connection.query(
          "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
          [photoValues],
        );
        console.log(
          `📸 ${uploadResults.length} fotos subidas y registradas con éxito.`,
        );
      }
    }

    // ==========================================
    // 6. INSERTAR DETALLE DE LLAMADA
    // ==========================================
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Anónimo",
        ],
      );
      console.log(`📞 Detalle de llamada registrado.`);
    }

    // ==========================================
    // 7. INSERTAR DETALLE DE AGRESORES
    // ==========================================
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
      console.log(`⚠️ ${agresores_detalle.length} agresores registrados.`);
    }

    // ==========================================
    // 8. INSERTAR DETALLE DE VÍCTIMAS
    // ==========================================
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
      console.log(`👤 ${victimas_detalle.length} víctimas registradas.`);
    }

    // Finaliza la transacción de forma exitosa
    await connection.commit();
    res.status(201).json({
      success: true,
      message:
        "Servicio iniciado y datos de ocurrencia consolidados correctamente.",
      id: id_nueva_ocurrencia,
    });
  } catch (error) {
    // Si hay error, revertimos la base de datos
    if (connection) await connection.rollback();
    console.error("🔴 ERROR EN INICIAR SERVICIO-CHECKLIST:", error.message);

    // Limpieza preventiva de imágenes en Cloudinary si falló la DB
    if (uploadedPublicIds.length > 0) {
      console.log(
        "🧹 Limpiando imágenes subidas a Cloudinary por error en transacción...",
      );
      for (const pId of uploadedPublicIds) {
        await cloudinary.uploader
          .destroy(pId)
          .catch((oerr) =>
            console.error("Error borrando huérfana:", oerr.message),
          );
      }
    }

    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
//completo vericicar
app.get("/catalogos/checklist-items", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // Consulta simple para traer todos los activos
    const sql = `
            SELECT id_item, componente AS nombre_item 
            FROM checklist_items 
            WHERE estado_activo = 1
        `;

    const [rows] = await connection.query(sql);
    res.json(rows);
  } catch (error) {
    console.error("Error en checklist:", error);
    res.status(500).json([]);
  } finally {
    if (connection) connection.release();
  }
});
app.get("/catalogos/checklist-itemsfiltro", async (req, res) => {
  const { id_tipo_vehiculo } = req.query;

  if (!id_tipo_vehiculo) {
    return res
      .status(400)
      .json({ error: "Falta el parámetro id_tipo_vehiculo" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    const sql = `
            SELECT id_item, componente AS nombre_item 
            FROM checklist_items 
            WHERE estado_activo = 1 AND id_tipo_vehiculo = ?
        `;

    const [rows] = await connection.query(sql, [id_tipo_vehiculo]);
    res.json(rows);
  } catch (error) {
    console.error("Error en checklist:", error);
    res.status(500).json([]);
  } finally {
    if (connection) connection.release();
  }
});
app.get("/catalogos/checklist-itemsfiltro1", async (req, res) => {
  const { id_tipo_vehiculo } = req.query;

  if (!id_tipo_vehiculo) {
    return res
      .status(400)
      .json({ error: "Falta el parámetro id_tipo_vehiculo" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    const sql = `
           SELECT 
        cc.id_categoria, 
        cc.nombre_categoria, 
        c.id_item, 
        c.componente AS nombre_item 
    FROM checklist_items AS c 
    INNER JOIN checklist_categorias AS cc ON cc.id_categoria = c.id_categoria 
    WHERE c.estado_activo = 1  AND id_tipo_vehiculo = ?
    ORDER BY cc.nombre_categoria, c.componente
        `;

    const [rows] = await connection.query(sql, [id_tipo_vehiculo]);
    res.json(rows);
  } catch (error) {
    console.error("Error en checklist:", error);
    res.status(500).json([]);
  } finally {
    if (connection) connection.release();
  }
});
app.post("/api/vehiculo/iniciar-servicio-checkcompleto", async (req, res) => {
  let connection;
  let uploadedPublicIds = []; // Control para revertir subidas a Cloudinary si hay rollback

  try {
    console.log(
      "📩 PETICIÓN RECIBIDA (Checklist + Ocurrencia Step 1):",
      req.body,
    );

    const {
      // Datos del Step 1 / Ocurrencia Principal
      id_usuario,
      id_lugar,
      id_modalidad,
      id_origen,
      id_camara,
      id_tipop,
      id_modalidadp,
      descripcion,
      hora_alerta,
      hora_llegada,
      hora_repliegue,
      latitud_gps,
      longitud_gps,
      nombre_punto_gps,
      referencia,
      unidad_encargada,
      fecha_evento,
      grupo,
      fotos,
      vehiculos_detalle,
      id_personal_ids, // Array de IDs de personal de apoyo
      detalle_llamada, // Objeto: { numero_telefono, nombre_informante }
      agresores_detalle, // Array de objetos de agresores
      victimas_detalle, // Array de objetos de víctimas

      // NOTA: Si manejas campos adicionales del Checklist (ej. kilometraje, nivel_combustible, etc.),
      // agrégalos aquí abajo para utilizarlos en sus respectivas tablas si es necesario.
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();
const fechaReportePeru = new Date().toLocaleString("sv-SE", { timeZone: "America/Lima" });
  
    // ==========================================
    // 1. INSERTAR OCURRENCIA PRINCIPAL
    // ==========================================
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      id_lugar,
      id_usuario,
      id_modalidad,
      id_origen,
      id_tipop || null,
      id_modalidadp || null,
      latitud_gps || 0,
      longitud_gps || 0,
      nombre_punto_gps || "",
      referencia || "",
      unidad_encargada || "SERENAZGO",
      fechaReportePeru,// 17
      fecha_evento,
      grupo,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;
    console.log(`✨ Ocurrencia registrada con ID: ${id_nueva_ocurrencia}`);

    // ==========================================
    // 2. INSERTAR DETALLE DE CÁMARAS
    // ==========================================
    if (id_camara) {
      let idsCam = Array.isArray(id_camara)
        ? id_camara
        : typeof id_camara === "string"
          ? id_camara.split(",")
          : [];
      const idsCamLimpios = idsCam
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsCamLimpios.length > 0) {
        const valuesCamara = idsCamLimpios.map((camId) => [
          id_nueva_ocurrencia,
          camId,
        ]);
        await connection.query(
          "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
          [valuesCamara],
        );
        console.log(`🎥 ${idsCamLimpios.length} cámaras vinculadas.`);
      }
    }

    // ==========================================
    // 3. INSERTAR PERSONAL DE APOYO
    // ==========================================
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids)
        ? id_personal_ids
        : typeof id_personal_ids === "string"
          ? id_personal_ids.split(",")
          : [];
      const idsPersLimpios = idsPers
        .map((id) => parseInt(id))
        .filter((id) => !isNaN(id));

      if (idsPersLimpios.length > 0) {
        const valuesPersonal = idsPersLimpios.map((persId) => [
          id_nueva_ocurrencia,
          persId,
        ]);
        await connection.query(
          "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
          [valuesPersonal],
        );
        console.log(`👮 ${idsPersLimpios.length} agentes de apoyo vinculados.`);
      }
    }

    // ==========================================
    // 4. INSERTAR VEHÍCULOS DEL DETALLE
    // ==========================================
    // ==========================================
    // 4. INSERTAR VEHÍCULOS DEL DETALLE + AUDITORÍA DE RELEVO
    // ==========================================
    // ==========================================
    // 4. INSERTAR VEHÍCULOS DEL DETALLE + CHECKLIST + AUDITORÍA DE RELEVO
    // ==========================================
    if (vehiculos_detalle && vehiculos_detalle.length > 0) {
      for (const v of vehiculos_detalle) {
        const id_unidad = v.id_unidad;
        const odometro_inicial = v.odometro_inicial
          ? parseInt(v.odometro_inicial)
          : 0;
        const id_tipo_vehiculo = v.id_tipo_vehiculo || 2; // Por defecto 2 (Camioneta)

        // ─── A. CALCULAR EL TURNO EN TIEMPO REAL (REEMPLAZO DEL TRIGGER) ───
        const ahora = new Date();
        const hora_actual = ahora.toTimeString().split(" ")[0]; // Formato "HH:MM:SS"
        let turno_calculado = "NOCHE";

        if (id_tipo_vehiculo === 1) {
          // MOTOCICLETA
          if (hora_actual >= "05:30:00" && hora_actual < "13:30:00")
            turno_calculado = "MAÑANA";
          else if (hora_actual >= "13:30:00" && hora_actual < "20:30:00")
            turno_calculado = "TARDE";
        } else {
          // CAMIONETA O SCOOTER
          if (hora_actual >= "06:30:00" && hora_actual < "14:30:00")
            turno_calculado = "MAÑANA";
          else if (hora_actual >= "14:30:00" && hora_actual < "21:30:00")
            turno_calculado = "TARDE";
        }

        // ─── B. BUSCAR REGISTRO ANTERIOR ABIERTO (REEMPLAZO DEL TRIGGER) ───
        const sqlBuscarAnt = `
                    SELECT id_detalle, odometro_inicial, fecha_asignacion 
                    FROM ocurrencia_vehiculo_detalle
                    WHERE id_unidad = ? AND odometro_final IS NULL
                    ORDER BY fecha_asignacion DESC LIMIT 1`;

        const [registrosAnt] = await connection.query(sqlBuscarAnt, [
          id_unidad,
        ]);

        if (registrosAnt.length > 0) {
          const ant = registrosAnt[0];
          const fecha_ant = new Date(ant.fecha_asignacion);
          const horas_transcurridas = Math.abs(ahora - fecha_ant) / 36e5; // Diferencia en horas flotantes

          // Si está dentro del rango normal de relevo continuo (<= 10 horas)
          if (horas_transcurridas <= 10) {
            if (odometro_inicial >= ant.odometro_inicial) {
              // Kilometraje coherente -> Se cierra el servicio anterior limpio
              await connection.query(
                `UPDATE ocurrencia_vehiculo_detalle SET odometro_final = ?, estado_cierre = 'REGISTRADO' WHERE id_detalle = ?`,
                [odometro_inicial, ant.id_detalle],
              );
            } else {
              // Alerta kilometraje menor -> Pasa a revisión de auditoría
              await connection.query(
                `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
                [ant.id_detalle],
              );
            }
          } else {
            // Pasaron más de 10 horas -> Se le olvidó cerrar turno
            await connection.query(
              `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
              [ant.id_detalle],
            );
          }
        }

        // ─── C. INSERTAR EL NUEVO REGISTRO DE ASIGNACIÓN VEHÍCULAR ───
        const [resVehiculoDetalle] = await connection.query(
          `INSERT INTO ocurrencia_vehiculo_detalle 
                    (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp, odometro_inicial, fecha_asignacion) 
                    VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [
            id_nueva_ocurrencia,
            id_tipo_vehiculo,
            id_unidad,
            turno_calculado,
            v.id_pnp || null,
            odometro_inicial,
          ],
        );

        // Capturamos el id_detalle que generó la base de datos para este vehículo específico
        const id_nuevo_detalle = resVehiculoDetalle.insertId;

        // D. INSERTAR CHECKLIST (Si existe en el payload, se inserta aquí)
        if (
          v.checklist_items &&
          Array.isArray(v.checklist_items) &&
          v.checklist_items.length > 0
        ) {
          const valuesChecklist = v.checklist_items.map((item) => [
            id_nuevo_detalle,
            parseInt(item.id_item),
            parseInt(item.esta_conforme),
            item.observacion || "",
          ]);
          await connection.query(
            "INSERT INTO ocurrencia_vehiculo_checklist (id_detalle, id_item, esta_conforme, observacion) VALUES ?",
            [valuesChecklist],
          );
        }
      }
      console.log(
        `🚗 ${vehiculos_detalle.length} vehículos y sus checklists procesados correctamente.`,
      );
    }

    // ==========================================
    // 5. PROCESAR SUBIDA DE FOTOS A CLOUDINARY
    // ==========================================
    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      const uploadPromises = fotos
        .filter((f) => f && f.base64_data)
        .map((f) => {
          const fileStr = f.base64_data.startsWith("data:")
            ? f.base64_data
            : `data:image/jpeg;base64,${f.base64_data}`;

          return cloudinary.uploader
            .upload(fileStr, {
              upload_preset: "renderizado",
              chunk_size: 6000000, // Bloques de 6MB para archivos pesados
            })
            .catch((err) => {
              console.error(
                "❌ Error subiendo una foto individual a Cloudinary:",
                err.message,
              );
              return null;
            });
        });

      const uploadResultsRaw = await Promise.all(uploadPromises);
      const uploadResults = uploadResultsRaw.filter((r) => r !== null);

      if (uploadResults.length > 0) {
        uploadedPublicIds = uploadResults.map((r) => r.public_id);

        const photoValues = uploadResults.map((r) => [
          id_nueva_ocurrencia,
          r.secure_url,
          r.public_id,
        ]);

        await connection.query(
          "INSERT INTO foto_ocurrencia_registro (id_ocurrencia, url_imagen, public_id) VALUES ?",
          [photoValues],
        );
        console.log(
          `📸 ${uploadResults.length} fotos subidas y registradas con éxito.`,
        );
      }
    }

    // ==========================================
    // 6. INSERTAR DETALLE DE LLAMADA
    // ==========================================
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [
          id_nueva_ocurrencia,
          detalle_llamada.numero_telefono,
          detalle_llamada.nombre_informante || "Anónimo",
        ],
      );
      console.log(`📞 Detalle de llamada registrado.`);
    }

    // ==========================================
    // 7. INSERTAR DETALLE DE AGRESORES
    // ==========================================
    if (
      agresores_detalle &&
      Array.isArray(agresores_detalle) &&
      agresores_detalle.length > 0
    ) {
      const valuesAgresores = agresores_detalle.map((a) => [
        id_nueva_ocurrencia,
        a.nombre_agresor || "N.N.",
        a.id_tipo_vehiculo || null,
        a.placa_agresor || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
        [valuesAgresores],
      );
      console.log(`⚠️ ${agresores_detalle.length} agresores registrados.`);
    }

    // ==========================================
    // 8. INSERTAR DETALLE DE VÍCTIMAS
    // ==========================================
    if (
      victimas_detalle &&
      Array.isArray(victimas_detalle) &&
      victimas_detalle.length > 0
    ) {
      const valuesVictimas = victimas_detalle.map((v) => [
        id_nueva_ocurrencia,
        v.nombre_victima || "N.N.",
        v.id_tipo_vehiculo || null,
        v.placa_victima || null,
        v.id_relacion_v || null,
      ]);
      await connection.query(
        "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
        [valuesVictimas],
      );
      console.log(`👤 ${victimas_detalle.length} víctimas registradas.`);
    }

    // Finaliza la transacción de forma exitosa
    await connection.commit();
    res.status(201).json({
      success: true,
      message:
        "Servicio iniciado y datos de ocurrencia consolidados correctamente.",
      id: id_nueva_ocurrencia,
    });
  } catch (error) {
    // Si hay error, revertimos la base de datos
    if (connection) await connection.rollback();
    console.error("🔴 ERROR EN INICIAR SERVICIO-CHECKLIST:", error.message);

    // Limpieza preventiva de imágenes en Cloudinary si falló la DB
    if (uploadedPublicIds.length > 0) {
      console.log(
        "🧹 Limpiando imágenes subidas a Cloudinary por error en transacción...",
      );
      for (const pId of uploadedPublicIds) {
        await cloudinary.uploader
          .destroy(pId)
          .catch((oerr) =>
            console.error("Error borrando huérfana:", oerr.message),
          );
      }
    }

    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});



//inseta bien ey mal del cheklist
app.post(
  "/api/vehiculo/iniciar-servicio-checkcompleto123seg",
  async (req, res) => {
    let connection;

    try {
      console.log(
        "📩 PETICIÓN RECIBIDA (Checklist + Ocurrencia + R2):",
        req.body
      );

      const {
        // Datos del Step 1 / Ocurrencia Principal
        id_usuario,
        id_lugar,
        id_modalidad,
        id_origen,
        id_camara,
        id_radio,
        id_zona,
        id_tipop,
        id_modalidadp,
        descripcion,
        hora_alerta,
        hora_llegada,
        hora_repliegue,
        latitud_gps,
        longitud_gps,
        nombre_punto_gps,
        referencia,
        unidad_encargada,
        fecha_evento,
        grupo,
        turno,
        estadoOcurrencia,
        fotos,
        vehiculos_detalle,
        id_personal_ids, // Array de IDs de personal de apoyo
        detalle_llamada, // Objeto: { numero_telefono, nombre_informante }
        agresores_detalle, // Array de objetos de agresores
        victimas_detalle, // Array de objetos de víctimas
      } = req.body;

      connection = await db.getConnection();
      await connection.beginTransaction();

      // ==========================================
      // 1. INSERTAR OCURRENCIA PRINCIPAL
      // ==========================================
      const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo,turno
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?,?)`;

      const [resOcurrencia] = await connection.query(sqlOcurrencia, [
        descripcion,
        hora_alerta || null,
        hora_llegada || null,
        hora_repliegue || null,
        id_lugar,
        id_usuario,
        id_modalidad,
        id_origen,
        id_tipop || null,
        id_modalidadp || null,
        latitud_gps || 0,
        longitud_gps || 0,
        nombre_punto_gps || "",
        referencia || "",
        unidad_encargada || "SERENAZGO",
        fecha_evento,
        estadoOcurrencia,
        grupo,
        turno,
      ]);

      const id_nueva_ocurrencia = resOcurrencia.insertId;
      console.log(`✨ Ocurrencia registrada con ID: ${id_nueva_ocurrencia}`);

      // ==========================================
      // 2. INSERTAR DETALLE DE CÁMARAS
      // ==========================================
      if (id_camara) {
        let idsCam = Array.isArray(id_camara)
          ? id_camara
          : typeof id_camara === "string"
            ? id_camara.split(",")
            : [];
        const idsCamLimpios = idsCam
          .map((id) => parseInt(id))
          .filter((id) => !isNaN(id));

        if (idsCamLimpios.length > 0) {
          const valuesCamara = idsCamLimpios.map((camId) => [
            id_nueva_ocurrencia,
            camId,
          ]);
          await connection.query(
            "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
            [valuesCamara]
          );
          console.log(`🎥 ${idsCamLimpios.length} cámaras vinculadas.`);
        }
      }

      // ==========================================
      // 3. INSERTAR PERSONAL DE APOYO
      // ==========================================
      if (id_personal_ids) {
        let idsPers = Array.isArray(id_personal_ids)
          ? id_personal_ids
          : typeof id_personal_ids === "string"
            ? id_personal_ids.split(",")
            : [];
        const idsPersLimpios = idsPers
          .map((id) => parseInt(id))
          .filter((id) => !isNaN(id));

        if (idsPersLimpios.length > 0) {
          const valuesPersonal = idsPersLimpios.map((persId) => [
            id_nueva_ocurrencia,
            persId,
          ]);
          await connection.query(
            "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
            [valuesPersonal]
          );
          console.log(
            `👮 ${idsPersLimpios.length} agentes de apoyo vinculados.`
          );
        }
      }

      // ==========================================
      // 4. INSERTAR VEHÍCULOS DEL DETALLE Y CHECKLIST
      // ==========================================
      if (vehiculos_detalle && Array.isArray(vehiculos_detalle) && vehiculos_detalle.length > 0) {
        for (const v of vehiculos_detalle) {
          const id_unidad = v.id_unidad;
          const odometro_inicial = v.odometro_inicial ? parseInt(v.odometro_inicial) : 0;
          const id_tipo_vehiculo = v.id_tipo_vehiculo || 2;

          let turno_a_guardar = null;
          let id_radio_final = null;
          let id_zona_final = null;

          // Normalización numérica para evitar discrepancias tipo string/number
          const modalidadNum = Number(id_modalidad);

          // SOLO EJECUTAR LÓGICA DE VEHÍCULOS SI ID_MODALIDAD ES 1
          if (modalidadNum === 1) {
            id_radio_final = v.id_radio || id_radio || null;
            id_zona_final = v.id_zona || id_zona || null;

            const horaNum = new Date().getHours();

            // 1. LÓGICA DE ESTADO (ACTIVO/INACTIVO)
            let es_activo = false;
            if (id_tipo_vehiculo === 1) {
              // MOTO
              if (
                (horaNum >= 5 && horaNum < 14) ||
                (horaNum >= 13 && horaNum < 21) ||
                horaNum >= 20 ||
                horaNum < 6
              )
                es_activo = true;
            } else {
              // OTROS
              if (
                (horaNum >= 6 && horaNum < 15) ||
                (horaNum >= 14 && horaNum < 22) ||
                horaNum >= 21 ||
                horaNum < 7
              )
                es_activo = true;
            }
            turno_a_guardar = es_activo ? "ACTIVO" : "INACTIVO";

            // 2. AUDITORÍA DE RELEVO (BUSCAR REGISTRO ANTERIOR ABIERTO)
            const sqlBuscarAnt = `
                SELECT id_detalle, odometro_inicial, fecha_asignacion 
                FROM ocurrencia_vehiculo_detalle
                WHERE id_unidad = ? AND odometro_final IS NULL
                ORDER BY fecha_asignacion DESC LIMIT 1`;

            const [registrosAnt] = await connection.query(sqlBuscarAnt, [id_unidad]);

            if (registrosAnt.length > 0) {
              const ant = registrosAnt[0];
              const fecha_ant = new Date(ant.fecha_asignacion);
              const horas_transcurridas = Math.abs(new Date() - fecha_ant) / 36e5;

              if (
                horas_transcurridas <= 10 &&
                odometro_inicial >= ant.odometro_inicial
              ) {
                await connection.query(
                  `UPDATE ocurrencia_vehiculo_detalle SET odometro_final = ?, estado_cierre = 'REGISTRADO' WHERE id_detalle = ?`,
                  [odometro_inicial, ant.id_detalle]
                );
              } else {
                await connection.query(
                  `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
                  [ant.id_detalle]
                );
              }
            }
          }

          // 3. INSERTAR NUEVO REGISTRO EN VEHICULO_DETALLE
          const [resVehiculoDetalle] = await connection.query(
            `INSERT INTO ocurrencia_vehiculo_detalle 
            (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp, odometro_inicial, fecha_asignacion, id_radio, id_zona) 
            VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [
              id_nueva_ocurrencia,
              id_tipo_vehiculo,
              id_unidad,
              turno_a_guardar,
              v.id_pnp || null,
              odometro_inicial,
              id_radio_final,
              id_zona_final,
            ]
          );

          const id_detalle_insertado = resVehiculoDetalle.insertId;
          console.log(`🚛 Vehículo registrado en detalle con ID: ${id_detalle_insertado}`);

          // 4. INSERTAR CHECKLIST (Procesa checklist_items o checklist)
          const itemsChecklist = v.checklist_items || v.checklist;

          if (Array.isArray(itemsChecklist) && itemsChecklist.length > 0) {
            const valuesChecklist = itemsChecklist
              .map((item) => {
                const idItem = parseInt(item.id_item || item.id);
                // Evalúa formatos booleano, numérico o string
                const estaConforme =
                  item.esta_conforme === true ||
                  item.esta_conforme === 1 ||
                  item.esta_conforme === "1"
                    ? 1
                    : 0;
                const observacion = item.observacion || "";

                if (isNaN(idItem)) return null;

                return [
                  id_detalle_insertado,
                  idItem,
                  estaConforme,
                  observacion,
                ];
              })
              .filter((row) => row !== null); // Limpieza de registros inválidos

            if (valuesChecklist.length > 0) {
              await connection.query(
                "INSERT INTO ocurrencia_vehiculo_checklist (id_detalle, id_item, esta_conforme, observacion) VALUES ?",
                [valuesChecklist]
              );
              console.log(
                `📋 ${valuesChecklist.length} ítems de checklist insertados para el detalle ${id_detalle_insertado}.`
              );
            } else {
              console.warn(
                "⚠️ El arreglo de checklist no contenía IDs de ítems válidos."
              );
            }
          } else {
            console.warn(
              `⚠️ No se encontraron ítems de checklist para la unidad ${id_unidad}.`
            );
          }
        }
      }

      // ==========================================
      // 5. INSERTAR DETALLE DE LLAMADA
      // ==========================================
      if (detalle_llamada && detalle_llamada.numero_telefono) {
        await connection.query(
          "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
          [
            id_nueva_ocurrencia,
            detalle_llamada.numero_telefono,
            detalle_llamada.nombre_informante || "Anónimo",
          ]
        );
      }

      // ==========================================
      // 6. INSERTAR DETALLE DE AGRESORES
      // ==========================================
      if (
        agresores_detalle &&
        Array.isArray(agresores_detalle) &&
        agresores_detalle.length > 0
      ) {
        const valuesAgresores = agresores_detalle.map((a) => [
          id_nueva_ocurrencia,
          a.nombre_agresor || "N.N.",
          a.id_tipo_vehiculo || null,
          a.placa_agresor || null,
        ]);
        await connection.query(
          "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
          [valuesAgresores]
        );
      }

      // ==========================================
      // 7. INSERTAR DETALLE DE VÍCTIMAS
      // ==========================================
      if (
        victimas_detalle &&
        Array.isArray(victimas_detalle) &&
        victimas_detalle.length > 0
      ) {
        const valuesVictimas = victimas_detalle.map((v) => [
          id_nueva_ocurrencia,
          v.nombre_victima || "N.N.",
          v.id_tipo_vehiculo || null,
          v.placa_victima || null,
          v.id_relacion_v || null,
        ]);
        await connection.query(
          "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
          [valuesVictimas]
        );
      }

      // Confirmar todos los cambios en la base de datos
      await connection.commit();

      // RESPUESTA AL CLIENTE
      res.status(201).json({
        success: true,
        message: "Servicio e inicio de checklist guardados correctamente.",
        id: id_nueva_ocurrencia,
      });

      // =========================================================
      // 8. PROCESAR Y SUBIR FOTOS A CLOUDFLARE R2 EN SEGUNDO PLANO
      // =========================================================
      if (fotos && Array.isArray(fotos) && fotos.length > 0) {
        procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(
          (err) => {
            console.error(
              "🔴 Error en subida asíncrona de fotos a R2:",
              err.message
            );
          }
        );
      }
    } catch (error) {
      if (connection) await connection.rollback();
      console.error("🔴 ERROR EN REGISTRO DE INICIO DE SERVICIO:", error.message);
      if (!res.headersSent) {
        res.status(400).json({ success: false, error: error.message });
      }
    } finally {
      if (connection) connection.release();
    }
  }
);
//solo inserta lo que esa mal
app.post("/api/vehiculo/iniciar-servicio-checkcompleto123ss",
  async (req, res) => {
    let connection;

    try {
      console.log(
        "📩 PETICIÓN RECIBIDA (Checklist + Ocurrencia + R2):",
        req.body
      );

      const {
        // Datos del Step 1 / Ocurrencia Principal
        id_usuario,
        id_lugar,
        id_modalidad,
        id_origen,
        id_camara,
        id_radio,
        id_zona,
        id_tipop,
        id_modalidadp,
        descripcion,
        hora_alerta,
        hora_llegada,
        hora_repliegue,
        latitud_gps,
        longitud_gps,
        nombre_punto_gps,
        referencia,
        unidad_encargada,
        fecha_evento,
        grupo,
        turno,
        estadoOcurrencia,
        fotos,
        vehiculos_detalle,
        id_personal_ids, // Array de IDs de personal de apoyo
        detalle_llamada, // Objeto: { numero_telefono, nombre_informante }
        agresores_detalle, // Array de objetos de agresores
        victimas_detalle, // Array de objetos de víctimas
      } = req.body;

      connection = await db.getConnection();
      await connection.beginTransaction();

      // ==========================================
      // 1. INSERTAR OCURRENCIA PRINCIPAL
      // ==========================================
      const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
            descripcion, hora_alerta, hora_llegada, hora_repliegue, 
            id_lugar, id_usuario, id_modalidad, id_origen,
            id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
            nombre_punto_gps, referencia, unidad_encargada, 
            fecha_reporte, fecha_evento, estado, grupo,turno
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?,?)`;

      const [resOcurrencia] = await connection.query(sqlOcurrencia, [
        descripcion,
        hora_alerta || null,
        hora_llegada || null,
        hora_repliegue || null,
        id_lugar,
        id_usuario,
        id_modalidad,
        id_origen,
        id_tipop || null,
        id_modalidadp || null,
        latitud_gps || 0,
        longitud_gps || 0,
        nombre_punto_gps || "",
        referencia || "",
        unidad_encargada || "SERENAZGO",
        fecha_evento,
        estadoOcurrencia,
        grupo,
        turno || null,
      ]);

      const id_nueva_ocurrencia = resOcurrencia.insertId;
      console.log(`✨ Ocurrencia registrada con ID: ${id_nueva_ocurrencia}`);

      // ==========================================
      // 2. INSERTAR DETALLE DE CÁMARAS
      // ==========================================
      if (id_camara) {
        let idsCam = Array.isArray(id_camara)
          ? id_camara
          : typeof id_camara === "string"
            ? id_camara.split(",")
            : [];
        const idsCamLimpios = idsCam
          .map((id) => parseInt(id))
          .filter((id) => !isNaN(id));

        if (idsCamLimpios.length > 0) {
          const valuesCamara = idsCamLimpios.map((camId) => [
            id_nueva_ocurrencia,
            camId,
          ]);
          await connection.query(
            "INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?",
            [valuesCamara]
          );
          console.log(`🎥 ${idsCamLimpios.length} cámaras vinculadas.`);
        }
      }

      // ==========================================
      // 3. INSERTAR PERSONAL DE APOYO
      // ==========================================
      if (id_personal_ids) {
        let idsPers = Array.isArray(id_personal_ids)
          ? id_personal_ids
          : typeof id_personal_ids === "string"
            ? id_personal_ids.split(",")
            : [];
        const idsPersLimpios = idsPers
          .map((id) => parseInt(id))
          .filter((id) => !isNaN(id));

        if (idsPersLimpios.length > 0) {
          const valuesPersonal = idsPersLimpios.map((persId) => [
            id_nueva_ocurrencia,
            persId,
          ]);
          await connection.query(
            "INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?",
            [valuesPersonal]
          );
          console.log(
            `👮 ${idsPersLimpios.length} agentes de apoyo vinculados.`
          );
        }
      }

      // ==========================================
      // 4. INSERTAR VEHÍCULOS DEL DETALLE Y CHECKLIST
      // ==========================================
      if (vehiculos_detalle && Array.isArray(vehiculos_detalle) && vehiculos_detalle.length > 0) {
        for (const v of vehiculos_detalle) {
          const id_unidad = v.id_unidad;
          const odometro_inicial = v.odometro_inicial ? parseInt(v.odometro_inicial) : 0;
          const id_tipo_vehiculo = v.id_tipo_vehiculo || 2;

          let turno_a_guardar = null;
          let id_radio_final = null;
          let id_zona_final = null;

          const modalidadNum = Number(id_modalidad);

          if (modalidadNum === 1) {
            id_radio_final = v.id_radio || id_radio || null;
            id_zona_final = v.id_zona || id_zona || null;

            const horaNum = new Date().getHours();

            let es_activo = false;
            if (id_tipo_vehiculo === 1) {
              if (
                (horaNum >= 5 && horaNum < 14) ||
                (horaNum >= 13 && horaNum < 21) ||
                horaNum >= 20 ||
                horaNum < 6
              )
                es_activo = true;
            } else {
              if (
                (horaNum >= 6 && horaNum < 15) ||
                (horaNum >= 14 && horaNum < 22) ||
                horaNum >= 21 ||
                horaNum < 7
              )
                es_activo = true;
            }
            turno_a_guardar = es_activo ? "ACTIVO" : "INACTIVO";

            const sqlBuscarAnt = `
                SELECT id_detalle, odometro_inicial, fecha_asignacion 
                FROM ocurrencia_vehiculo_detalle
                WHERE id_unidad = ? AND odometro_final IS NULL
                ORDER BY fecha_asignacion DESC LIMIT 1`;

            const [registrosAnt] = await connection.query(sqlBuscarAnt, [id_unidad]);

            if (registrosAnt.length > 0) {
              const ant = registrosAnt[0];
              const fecha_ant = new Date(ant.fecha_asignacion);
              const horas_transcurridas = Math.abs(new Date() - fecha_ant) / 36e5;

              if (
                horas_transcurridas <= 10 &&
                odometro_inicial >= ant.odometro_inicial
              ) {
                await connection.query(
                  `UPDATE ocurrencia_vehiculo_detalle SET odometro_final = ?, estado_cierre = 'REGISTRADO' WHERE id_detalle = ?`,
                  [odometro_inicial, ant.id_detalle]
                );
              } else {
                await connection.query(
                  `UPDATE ocurrencia_vehiculo_detalle SET estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
                  [ant.id_detalle]
                );
              }
            }
          }

          const [resVehiculoDetalle] = await connection.query(
            `INSERT INTO ocurrencia_vehiculo_detalle 
            (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp, odometro_inicial, fecha_asignacion, id_radio, id_zona) 
            VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [
              id_nueva_ocurrencia,
              id_tipo_vehiculo,
              id_unidad,
              turno_a_guardar,
              v.id_pnp || null,
              odometro_inicial,
              id_radio_final,
              id_zona_final,
            ]
          );

          const id_detalle_insertado = resVehiculoDetalle.insertId;
          console.log(`🚛 Vehículo registrado en detalle con ID: ${id_detalle_insertado}`);

          // -------------------------------------------------------------
          // 4.1. FILTRAR Y GUARDAR SOLO LO QUE ESTÁ MAL (esta_conforme === 0)
          // -------------------------------------------------------------
          const itemsChecklist = v.checklist_items || v.checklist;

          if (Array.isArray(itemsChecklist) && itemsChecklist.length > 0) {
            const valuesChecklist = itemsChecklist
              .filter((item) => {
                // Evaluamos si NO está conforme (esta_conforme === 0, false, "0")
                const estaConforme =
                  item.esta_conforme === true ||
                  item.esta_conforme === 1 ||
                  item.esta_conforme === "1";

                return !estaConforme; // Conserva SOLO los defectuosos/observados
              })
              .map((item) => {
                const idItem = parseInt(item.id_item || item.id);
                const observacion = item.observacion || "";

                if (isNaN(idItem)) return null;

                return [
                  id_detalle_insertado,
                  idItem,
                  0, // Guardamos 0 explicitamente
                  observacion,
                ];
              })
              .filter((row) => row !== null);

            if (valuesChecklist.length > 0) {
              await connection.query(
                "INSERT INTO ocurrencia_vehiculo_checklist (id_detalle, id_item, esta_conforme, observacion) VALUES ?",
                [valuesChecklist]
              );
              console.log(
                `⚠️ ${valuesChecklist.length} observaciones registradas para el vehículo ${id_unidad}.`
              );
            } else {
              console.log(
                `✅ El vehículo ${id_unidad} pasó la inspección sin observaciones (sin novedades).`
              );
            }
          }
        }
      }

      // ==========================================
      // 5. INSERTAR DETALLE DE LLAMADA
      // ==========================================
      if (detalle_llamada && detalle_llamada.numero_telefono) {
        await connection.query(
          "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
          [
            id_nueva_ocurrencia,
            detalle_llamada.numero_telefono,
            detalle_llamada.nombre_informante || "Anónimo",
          ]
        );
      }

      // ==========================================
      // 6. INSERTAR DETALLE DE AGRESORES
      // ==========================================
      if (
        agresores_detalle &&
        Array.isArray(agresores_detalle) &&
        agresores_detalle.length > 0
      ) {
        const valuesAgresores = agresores_detalle.map((a) => [
          id_nueva_ocurrencia,
          a.nombre_agresor || "N.N.",
          a.id_tipo_vehiculo || null,
          a.placa_agresor || null,
        ]);
        await connection.query(
          "INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?",
          [valuesAgresores]
        );
      }

      // ==========================================
      // 7. INSERTAR DETALLE DE VÍCTIMAS
      // ==========================================
      if (
        victimas_detalle &&
        Array.isArray(victimas_detalle) &&
        victimas_detalle.length > 0
      ) {
        const valuesVictimas = victimas_detalle.map((v) => [
          id_nueva_ocurrencia,
          v.nombre_victima || "N.N.",
          v.id_tipo_vehiculo || null,
          v.placa_victima || null,
          v.id_relacion_v || null,
        ]);
        await connection.query(
          "INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?",
          [valuesVictimas]
        );
      }

      await connection.commit();

      res.status(201).json({
        success: true,
        message: "Servicio e inicio de checklist guardados correctamente.",
        id: id_nueva_ocurrencia,
      });

      // =========================================================
      // 8. PROCESAR Y SUBIR FOTOS A CLOUDFLARE R2 EN SEGUNDO PLANO
      // =========================================================
      if (fotos && Array.isArray(fotos) && fotos.length > 0) {
        procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(
          (err) => {
            console.error(
              "🔴 Error en subida asíncrona de fotos a R2:",
              err.message
            );
          }
        );
      }
    } catch (error) {
      if (connection) await connection.rollback();
      console.error("🔴 ERROR EN REGISTRO DE INICIO DE SERVICIO:", error.message);
      if (!res.headersSent) {
        res.status(400).json({ success: false, error: error.message });
      }
    } finally {
      if (connection) connection.release();
    }
  }
);



// ==========================================
// ==========================================
// FUNCIÓN AUXILIAR: Cálculo de Fecha Operativa (Madrugada)
// ==========================================
function calcularFechaOperativa(fechaEventoStr, horaStr, tipoAccion, idTipoVehiculo) {
  const [hora, minuto] = String(horaStr || "00:00").split(":").map(Number);
  const hHora = hora + (minuto || 0) / 60;
  
  let fecha = new Date(fechaEventoStr);
  const esMotocicleta = Number(idTipoVehiculo) === 2; // ID 2 para motocicleta
  const limiteFin = esMotocicleta ? 8 : 9; // 8 AM para motos, 9 AM para autos
  
  const retrocederDia = (tipoAccion === 'FIN' && hHora < limiteFin) || 
                        (tipoAccion === 'INICIO' && hHora < 3);
  
  if (retrocederDia) {
    fecha.setDate(fecha.getDate() - 1); // Resta un día si pertenece a la madrugada
  }
  
  return fecha.toISOString().split('T')[0]; // Formato 'YYYY-MM-DD'
}


// ==========================================
// 1. ENDPOINT: INICIO DE SERVICIO (Con prevención de duplicados)
// ==========================================
app.post("/api/vehiculo/iniciar-servicio", async (req, res) => {
  let connection;

  try {
    console.log("📩 PETICIÓN RECIBIDA (Inicio de Servicio):", req.body);

    const {
      id_usuario, id_lugar, id_modalidad, id_origen, id_camara, id_radio, id_zona,
      id_tipop, id_modalidadp, descripcion, hora_alerta, hora_llegada, hora_repliegue,
      latitud_gps, longitud_gps, nombre_punto_gps, referencia, unidad_encargada,
      fecha_evento, grupo, turno, estadoOcurrencia, fotos, vehiculos_detalle,
      id_personal_ids, detalle_llamada, agresores_detalle, victimas_detalle
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();
const fechaReportePeru = new Date().toLocaleString("sv-SE", { timeZone: "America/Lima" });
  
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
        descripcion, hora_alerta, hora_llegada, hora_repliegue, 
        id_lugar, id_usuario, id_modalidad, id_modalidad_inicial, id_origen,
        id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
        nombre_punto_gps, referencia, unidad_encargada, 
        fecha_reporte, fecha_evento, estado, grupo, turno
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion, hora_alerta || null, hora_llegada || null, hora_repliegue || null,
      id_lugar, id_usuario, id_modalidad, id_modalidad, id_origen,
      id_tipop || null, id_modalidadp || null, latitud_gps || 0, longitud_gps || 0,
      nombre_punto_gps || "", referencia || "", unidad_encargada || "SERENAZGO",fechaReportePeru,
      fecha_evento, estadoOcurrencia, grupo, turno || null,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;

    // Cámaras
    if (id_camara) {
      let idsCam = Array.isArray(id_camara) ? id_camara : String(id_camara).split(",");
      const idsCamLimpios = idsCam.map((id) => parseInt(id)).filter((id) => !isNaN(id));
      if (idsCamLimpios.length > 0) {
        await connection.query("INSERT INTO detalle_camara_ocurrencia (id_ocurrencia, id_camara) VALUES ?", 
          [idsCamLimpios.map(camId => [id_nueva_ocurrencia, camId])]
        );
      }
    }

    // Personal de Apoyo
    if (id_personal_ids) {
      let idsPers = Array.isArray(id_personal_ids) ? id_personal_ids : String(id_personal_ids).split(",");
      const idsPersLimpios = idsPers.map((id) => parseInt(id)).filter((id) => !isNaN(id));
      if (idsPersLimpios.length > 0) {
        await connection.query("INSERT INTO personal_ocurrencia (id_ocurrencia, id_persona) VALUES ?", 
          [idsPersLimpios.map(persId => [id_nueva_ocurrencia, persId])]
        );
      }
    }

    // Vehículos y Checklist
    if (vehiculos_detalle && Array.isArray(vehiculos_detalle) && vehiculos_detalle.length > 0) {
      for (const v of vehiculos_detalle) {
        const id_unidad = v.id_unidad;
        const odometro_inicial = v.odometro_inicial ? parseInt(v.odometro_inicial) : 0;
        const id_tipo_vehiculo = v.id_tipo_vehiculo || 2;

        const fechaOperativaAsignacion = calcularFechaOperativa(fecha_evento, hora_alerta || "00:00", "INICIO", id_tipo_vehiculo);

        // PREVENCIÓN: Si la unidad tiene un turno abierto previo olvidado, ciérralo preventivamente
        const [vehiculoAbiertoPrevio] = await connection.query(
          `SELECT id_detalle FROM ocurrencia_vehiculo_detalle WHERE id_unidad = ? AND odometro_final IS NULL LIMIT 1`,
          [id_unidad]
        );

        if (vehiculoAbiertoPrevio.length > 0) {
          console.warn(`⚠️ La unidad ${id_unidad} tenía un turno abierto huérfano. Cerrando preventivamente...`);
          await connection.query(
            `UPDATE ocurrencia_vehiculo_detalle SET odometro_final = odometro_inicial, estado_cierre = 'PENDIENTE_AUDITORIA' WHERE id_detalle = ?`,
            [vehiculoAbiertoPrevio[0].id_detalle]
          );
        }

        let turno_a_guardar = null;
        let id_radio_final = null;
        let id_zona_final = null;

        if (Number(id_modalidad) === 1) {
          id_radio_final = v.id_radio || id_radio || null;
          id_zona_final = v.id_zona || id_zona || null;
          turno_a_guardar = "ACTIVO";
        }

        const [resVehiculoDetalle] = await connection.query(
          `INSERT INTO ocurrencia_vehiculo_detalle 
          (id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp, odometro_inicial, fecha_asignacion, id_radio, id_zona) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id_nueva_ocurrencia, id_tipo_vehiculo, id_unidad, turno_a_guardar,
            v.id_pnp || null, odometro_inicial, `${fechaOperativaAsignacion} ${hora_alerta || '00:00:00'}`,
            id_radio_final, id_zona_final
          ]
        );

        const id_detalle_insertado = resVehiculoDetalle.insertId;

        // Guardar checklist solo los defectuosos (esta_conforme === 0)
        const itemsChecklist = v.checklist_items || v.checklist;
        if (Array.isArray(itemsChecklist) && itemsChecklist.length > 0) {
          const valuesChecklist = itemsChecklist
            .filter((item) => !(item.esta_conforme === true || item.esta_conforme === 1 || item.esta_conforme === "1"))
            .map((item) => {
              const idItem = parseInt(item.id_item || item.id);
              return isNaN(idItem) ? null : [id_detalle_insertado, idItem, 0, item.observacion || ""];
            })
            .filter((row) => row !== null);

          if (valuesChecklist.length > 0) {
            await connection.query("INSERT INTO ocurrencia_vehiculo_checklist (id_detalle, id_item, esta_conforme, observacion) VALUES ?", [valuesChecklist]);
          }
        }
      }
    }

    // Llamadas, Agresores, Víctimas
    if (detalle_llamada && detalle_llamada.numero_telefono) {
      await connection.query(
        "INSERT INTO detalle_llamada_ocurrencia (id_ocurrencia, numero_telefono, nombre_informante) VALUES (?, ?, ?)",
        [id_nueva_ocurrencia, detalle_llamada.numero_telefono, detalle_llamada.nombre_informante || "Anónimo"]
      );
    }

    if (agresores_detalle && Array.isArray(agresores_detalle) && agresores_detalle.length > 0) {
      const valuesAgresores = agresores_detalle.map((a) => [id_nueva_ocurrencia, a.nombre_agresor || "N.N.", a.id_tipo_vehiculo || null, a.placa_agresor || null]);
      await connection.query("INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, id_tipo_vehiculo, placa_agresor) VALUES ?", [valuesAgresores]);
    }

    if (victimas_detalle && Array.isArray(victimas_detalle) && victimas_detalle.length > 0) {
      const valuesVictimas = victimas_detalle.map((v) => [id_nueva_ocurrencia, v.nombre_victima || "N.N.", v.id_tipo_vehiculo || null, v.placa_victima || null, v.id_relacion_v || null]);
      await connection.query("INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, id_tipo_vehiculo, placa_victima, id_relacion_v) VALUES ?", [valuesVictimas]);
    }

    await connection.commit();
    res.status(201).json({ success: true, message: "Inicio de servicio guardado correctamente.", id: id_nueva_ocurrencia });

    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(() => {});
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR EN INICIO:", error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});


// ==========================================
// 2. ENDPOINT: FIN DE SERVICIO (Búsqueda Blindada por Turno y Usuario)
// ==========================================
app.post("/api/vehiculo/finalizar-servicio", async (req, res) => {
  let connection;

  try {
    console.log("🏁 PETICIÓN RECIBIDA (Fin de Servicio):", req.body);

    const {
      id_usuario, id_lugar, id_modalidad, id_origen, descripcion, hora_alerta,
      latitud_gps, longitud_gps, nombre_punto_gps, referencia, unidad_encargada,
      fecha_evento, grupo, turno, estadoOcurrencia, fotos, vehiculos_detalle,
      id_tipop, id_modalidadp
    } = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();
const fechaReportePeru = new Date().toLocaleString("sv-SE", { timeZone: "America/Lima" });
  
    const sqlOcurrencia = `INSERT INTO ocurrencia_registro (
        descripcion, hora_alerta, hora_llegada, hora_repliegue, 
        id_lugar, id_usuario, id_modalidad, id_modalidad_inicial, id_origen,
        id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
        nombre_punto_gps, referencia, unidad_encargada, 
        fecha_reporte, fecha_evento, estado, grupo, turno
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const [resOcurrencia] = await connection.query(sqlOcurrencia, [
      descripcion || "Fin de Servicio", hora_alerta || null, hora_alerta || null, hora_alerta || null,
      id_lugar, id_usuario, id_modalidad, id_modalidad, id_origen || 9,
      id_tipop || null, id_modalidadp || null, latitud_gps || 0, longitud_gps || 0,
      nombre_punto_gps || "", referencia || "", unidad_encargada || "SERENAZGO",
      fecha_evento,fechaReportePeru, estadoOcurrencia, grupo, turno || null,
    ]);

    const id_nueva_ocurrencia = resOcurrencia.insertId;
    let alertasFaltaInicio = [];

    if (vehiculos_detalle && Array.isArray(vehiculos_detalle) && vehiculos_detalle.length > 0) {
      for (const v of vehiculos_detalle) {
        const id_unidad = v.id_unidad;
        const odometro_final_ingresado = v.odometro_inicial ? parseInt(v.odometro_inicial) : 0;
        const id_tipo_vehiculo = v.id_tipo_vehiculo || 2;

        const fechaOperativaCierre = calcularFechaOperativa(fecha_evento, hora_alerta || "00:00", "FIN", id_tipo_vehiculo);

        // BÚSQUEDA BLINDADA: Exige Unidad, Turno y Fecha Operativa exacta. Prioriza al usuario actual.
        const sqlBuscarAbierto = `
            SELECT d.id_detalle, d.odometro_inicial, o.id_usuario AS id_usuario_inicio, o.turno 
            FROM ocurrencia_vehiculo_detalle d
            JOIN ocurrencia_registro o ON d.id_ocurrencia = o.id_ocurrencia
            WHERE d.id_unidad = ? 
              AND d.odometro_final IS NULL
              AND o.turno = ?
              AND DATE(d.fecha_asignacion) = ?
            ORDER BY (o.id_usuario = ?) DESC, d.fecha_asignacion DESC
            LIMIT 1`;

        const [registrosAbiertos] = await connection.query(sqlBuscarAbierto, [
          id_unidad, turno, fechaOperativaCierre, id_usuario
        ]);

        if (registrosAbiertos.length > 0) {
          // CASO A: SÍ ENCONTRÓ EL INICIO ABIERTO -> ACTUALIZA LA MISMA FILA
          const ant = registrosAbiertos[0];
          let estadoCierre = "REGISTRADO";

          // Validar odómetro negativo (NEG)
          if (odometro_final_ingresado < ant.odometro_inicial) {
            estadoCierre = "PENDIENTE_AUDITORIA";
          }
          // Validar cambio de persona (OBS)
          if (Number(ant.id_usuario_inicio) !== Number(id_usuario)) {
            estadoCierre = "PENDIENTE_AUDITORIA";
          }

          await connection.query(
            `UPDATE ocurrencia_vehiculo_detalle 
             SET odometro_final = ?, estado_cierre = ? 
             WHERE id_detalle = ?`,
            [odometro_final_ingresado, estadoCierre, ant.id_detalle]
          );

          console.log(`🔒 Vehículo ${id_unidad} cerrado correctamente. Estado: ${estadoCierre}`);

        } else {
          // CASO B: NO ENCONTRÓ INICIO EXACTO -> ALERTA Y AUDITORÍA
          console.warn(`🚨 ALERTA: La unidad ${id_unidad} intenta cerrar pero NO TIENE UN INICIO VÁLIDO PARA ESTE TURNO/FECHA.`);
          alertasFaltaInicio.push(`Unidad ${id_unidad}: No registró inicio previo.`);

          await connection.query(
            `INSERT INTO ocurrencia_vehiculo_detalle 
            (id_ocurrencia, id_tipo_vehiculo, id_unidad, odometro_final, fecha_asignacion, estado_cierre) 
            VALUES (?, ?, ?, ?, NOW(), 'PENDIENTE_AUDITORIA')`,
            [id_nueva_ocurrencia, id_tipo_vehiculo, id_unidad, odometro_final_ingresado]
          );
        }
      }
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: alertasFaltaInicio.length > 0 
        ? "Servicio finalizado con advertencias: Algunos vehículos no registraron inicio." 
        : "Servicio finalizado correctamente.",
      alertas: alertasFaltaInicio,
      id: id_nueva_ocurrencia,
    });

    if (fotos && Array.isArray(fotos) && fotos.length > 0) {
      procesarYSubirFotosSegundoPlano(id_nueva_ocurrencia, fotos, db).catch(() => {});
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR EN FIN DE SERVICIO:", error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});


// ==========================================
// 3. ENDPOINT: LISTAR EL ÚLTIMO REGISTRO DE CADA PLACA (Dashboard estado actual)
// ==========================================
// 3. ENDPOINT: LISTAR EL ÚLTIMO REGISTRO DE CADA UNIDAD (Sin depender de tablas externas)
// ==========================================
app.get("/api/vehiculo/ultimo-estado-placas", async (req, res) => {
  try {
    const query = `
      SELECT 
          d.id_unidad,
          CONCAT('UNIDAD ', d.id_unidad) AS placa,
          d.id_detalle,
          d.fecha_asignacion,
          DATE_FORMAT(d.fecha_asignacion, '%Y-%m-%d') AS ultima_fecha,
          DATE_FORMAT(d.fecha_asignacion, '%H:%i:%s') AS ultima_hora,
          COALESCE(d.odometro_final, d.odometro_inicial, 0) AS ultimo_km_marcado,
          d.odometro_inicial,
          d.odometro_final,
          d.estado_cierre,
          o.turno,
          o.id_modalidad,
          p.id_persona,
          p.documento_numero AS documento_responsable,
          CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS personal_responsable,
          CASE 
              WHEN d.odometro_final IS NULL THEN 'INICIO (En Calle)'
              ELSE 'FIN (Cerrado)'
          END AS tipo_ultimo_marcado
      FROM (
          SELECT *, ROW_NUMBER() OVER(PARTITION BY id_unidad ORDER BY fecha_asignacion DESC) as rn
          FROM ocurrencia_vehiculo_detalle
      ) d
      LEFT JOIN ocurrencia_registro o ON d.id_ocurrencia = o.id_ocurrencia
      LEFT JOIN persona p ON o.id_usuario = p.id_persona
      WHERE d.rn = 1
      ORDER BY d.id_unidad ASC;
    `;
    
    const [rows] = await db.query(query);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Error al obtener matriz de placas:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. ENDPOINT: CONSOLIDADO PARA SEGUIMIENTO (Dashboard / Reporte km recorridos)
// ==========================================
// ==========================================
// 4. ENDPOINT CORREGIDO: CONSOLIDADO PARA SEGUIMIENTO (Histórico / Kilometraje)
// ==========================================
app.get("/api/vehiculo/consolidado-seguimiento", async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin, turno } = req.query;

    let filtros = [];
    let params = [];

    if (fecha_inicio && fecha_fin) {
      filtros.push("DATE(o.fecha_evento) BETWEEN ? AND ?");
      params.push(fecha_inicio, fecha_fin);
    }
    if (turno) {
      filtros.push("o.turno = ?");
      params.push(turno);
    }

    let whereClause = filtros.length > 0 ? "WHERE " + filtros.join(" AND ") : "";

    const query = `
      SELECT 
          d.id_detalle,
          CONCAT('UNIDAD ', d.id_unidad) AS placa,
          o.fecha_evento,
          o.turno,
          CONCAT('Usuario ID: ', o.id_usuario) AS personal,
          d.odometro_inicial,
          d.odometro_final,
          CASE 
              WHEN d.odometro_inicial IS NULL THEN 0
              WHEN d.odometro_final IS NULL THEN 0
              ELSE (d.odometro_final - d.odometro_inicial)
          END AS kilometros_recorridos,
          d.estado_cierre,
          o.descripcion AS tipo_movimiento
      FROM ocurrencia_vehiculo_detalle d
      JOIN ocurrencia_registro o ON d.id_ocurrencia = o.id_ocurrencia
      ${whereClause}
      ORDER BY d.fecha_asignacion DESC
      LIMIT 200;
    `;

    const [rows] = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Error al obtener consolidado:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// Ruta para obtener el estado de monitoreo de todas las unidades en tiempo real
app.get("/api/vehiculo/monitoreo-unidades", async (req, res) => {
  try {
    const queryMonitoreo = `
            SELECT 
                u.id_unidad,
                u.placa AS unidad_placa,
                CASE 
                    WHEN u.id_tipo_vehiculo = 1 THEN 'MOTOCICLETA'
                    WHEN u.id_tipo_vehiculo = 2 THEN 'CAMIONETA'
                    ELSE 'OTRO VEHÍCULO / SCOOTER'
                END AS tipo_unidad,
                
                -- Determina el estado actual para pintar en el sistema
                CASE 
                    WHEN ovd.id_detalle IS NOT NULL AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) <= 8 THEN 'OPERATIVO (EN RUTA)'
                    WHEN ovd.id_detalle IS NOT NULL AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) > 8 THEN 'ALERTA (SERVICIO PROLONGADO)'
                    ELSE 'DISPONIBLE (EN BASE)'
                END AS estado_servicio,

                -- Código de color sugerido para pintar el recuadro directamente
                CASE 
                    WHEN ovd.id_detalle IS NOT NULL AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) <= 8 THEN '#28A745' -- Verde (Normal)
                    WHEN ovd.id_detalle IS NOT NULL AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) > 8 AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) <= 16 THEN '#FFC107' -- Ámbar (Alerta Relevo)
                    WHEN ovd.id_detalle IS NOT NULL AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) > 16 THEN '#DC3545' -- Rojo (Crítico)
                    ELSE '#6C757D' -- Gris (Disponible/Sin iniciar servicio)
                END AS color_hex,

                ovd.tipo_asignacion AS ultimo_turno_activo,
                ovd.odometro_inicial AS odometro_salida,
                ovd.fecha_asignacion AS fecha_hora_salida,
                TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) AS horas_transcurridas_sin_relevo,
                
                CASE 
                    WHEN ovd.id_detalle IS NULL THEN 'UNIDAD EN BASE - LISTA PARA ASIGNAR'
                    WHEN TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) <= 8 THEN 'UNIDAD OPERANDO DENTRO DEL TURNO NORMAL'
                    WHEN TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) > 8 AND TIMESTAMPDIFF(HOUR, ovd.fecha_asignacion, NOW()) <= 16 THEN 'ALERTA: RELEVO NO REGISTRADO / TURNO TERMINADO'
                    ELSE 'CRÍTICO: UNIDAD ABANDONADA / INOPERATIVA SIN REPORTAR'
                END AS diagnostico_auditoria
            FROM unidad u
            LEFT JOIN de_ocurrencia_vehiculo_detalle ovd 
                ON u.id_unidad = ovd.id_unidad AND ovd.odometro_final IS NULL
            ORDER BY estado_servicio DESC, horas_transcurridas_sin_relevo DESC;
        `;

    // Ejecutamos la consulta en la base de datos
    const [rows] = await db.query(queryMonitoreo);

    // Retornamos el listado completo procesado
    res.status(200).json(rows);
  } catch (error) {
    console.error("Error en monitoreo de unidades:", error);
    res.status(500).json({
      error: "Error al obtener el reporte de auditoría en tiempo real.",
    });
  }
});





// Configuración Cloudinary (Asegúrate de poner tus datos reales)
cloudinary.config({
  cloud_name: "dplwunlzp",
  api_key: "515945841913642",
  api_secret: "PrB-RTZFI0SaagSEkrIn80ieZiI",
});
// --- FUNCIÓN NÚCLEO DE MIGRACIÓN ---

app.put("/ocurrencias/editar-sipcopse/:id_ocurrencia", async (req, res) => {
  let connection;
  try {
    const { id_ocurrencia } = req.params;
    const { id_modalidad } = req.body;

    // VALIDAR QUE EL CAMPO NO ESTÉ VACÍO O NULO
    if (
      id_modalidad === undefined ||
      id_modalidad === null ||
      id_modalidad === ""
    ) {
      return res.status(400).json({
        success: false,
        error: "EL ID DE MODALIDAD ES OBLIGATORIO",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. VERIFICAR SI LA OCURRENCIA REALMENTE EXISTE
    const [rows] = await connection.query(
      `SELECT id_ocurrencia FROM ocurrencia_registro WHERE id_ocurrencia = ?`,
      [id_ocurrencia],
    );

    if (!rows || rows.length === 0) {
      throw new Error("LA OCURRENCIA NO EXISTE");
    }

    // 2. VERIFICAR SI LA MODALIDAD EXISTE EN EL CATÁLOGO
    const [modalidadRows] = await connection.query(
      `SELECT id FROM cat_modalidad WHERE id = ?`,
      [id_modalidad],
    );

    if (!modalidadRows || modalidadRows.length === 0) {
      throw new Error("LA MODALIDAD SELECCIONADA NO ES VÁLIDA");
    }

    // 3. ACTUALIZAR ÚNICAMENTE EL ID_MODALIDAD EN LA TABLA OCURRENCIA_REGISTRO
    await connection.query(
      `UPDATE ocurrencia_registro 
       SET id_modalidad = ? 
       WHERE id_ocurrencia = ?`,
      [id_modalidad, id_ocurrencia],
    );

    await connection.commit();
    res.status(200).json({
      success: true,
      message: "MODALIDAD ACTUALIZADA CORRECTAMENTE",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR AL EDITAR MODALIDAD:", error.message);
    res
      .status(400)
      .json({ success: false, error: error.message.toUpperCase() });
  } finally {
    if (connection) connection.release();
  }
});
app.put("/ocurrencias/editar-sipcop/:id_ocurrencia", async (req, res) => {
  let connection;
  try {
    const { id_ocurrencia } = req.params;
    const { id_modalidad } = req.body;

    // VALIDAR QUE EL CAMPO NO ESTÉ VACÍO O NULO
    if (
      id_modalidad === undefined ||
      id_modalidad === null ||
      id_modalidad === ""
    ) {
      return res.status(400).json({
        success: false,
        error: "EL ID DE MODALIDAD ES OBLIGATORIO",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. VERIFICAR SI LA OCURRENCIA REALMENTE EXISTE
    const [rows] = await connection.query(
      `SELECT id_ocurrencia FROM ocurrencia_registro WHERE id_ocurrencia = ?`,
      [id_ocurrencia],
    );

    if (!rows || rows.length === 0) {
      throw new Error("LA OCURRENCIA NO EXISTE");
    }

    // 2. VERIFICAR SI LA MODALIDAD EXISTE EN EL CATÁLOGO
    const [modalidadRows] = await connection.query(
      `SELECT id FROM cat_modalidad WHERE id = ?`,
      [id_modalidad],
    );

    if (!modalidadRows || modalidadRows.length === 0) {
      throw new Error("LA MODALIDAD SELECCIONADA NO ES VÁLIDA");
    }

    // 3. ACTUALIZAR ÚNICAMENTE EL ID_MODALIDAD EN LA TABLA OCURRENCIA_REGISTRO
    await connection.query(
      `UPDATE ocurrencia_registro 
       SET id_modalidad = ? 
       WHERE id_ocurrencia = ?`,
      [id_modalidad, id_ocurrencia],
    );

    await connection.commit();
    res.status(200).json({
      success: true,
      message: "MODALIDAD ACTUALIZADA CORRECTAMENTE",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR AL EDITAR MODALIDAD:", error.message);
    res
      .status(400)
      .json({ success: false, error: error.message.toUpperCase() });
  } finally {
    if (connection) connection.release();
  }
});

app.put(
  "/ocurrencias/editarseguro1-sipcop/:id_ocurrencia",
  async (req, res) => {
    let connection;
    try {
      const { id_ocurrencia } = req.params;
      const { id_modalidad, nombre_agresor, placa_agresor, edad } = req.body;

      // VALIDAR QUE EL ID DE MODALIDAD NO ESTÉ VACÍO O NULO
      if (
        id_modalidad === undefined ||
        id_modalidad === null ||
        id_modalidad === ""
      ) {
        return res.status(400).json({
          success: false,
          error: "EL ID DE MODALIDAD ES OBLIGATORIO",
        });
      }

      connection = await db.getConnection();
      await connection.beginTransaction();

      // 1. VERIFICAR SI LA OCURRENCIA REALMENTE EXISTE
      const [rows] = await connection.query(
        `SELECT id_ocurrencia FROM ocurrencia_registro WHERE id_ocurrencia = ?`,
        [id_ocurrencia],
      );

      if (!rows || rows.length === 0) {
        throw new Error("LA OCURRENCIA NO EXISTE");
      }

      // 2. VERIFICAR SI LA MODALIDAD EXISTE EN EL CATÁLOGO
      const [modalidadRows] = await connection.query(
        `SELECT id FROM cat_modalidad WHERE id = ?`,
        [id_modalidad],
      );

      if (!modalidadRows || modalidadRows.length === 0) {
        throw new Error("LA MODALIDAD SELECCIONADA NO ES VÁLIDA");
      }

      // 3. ACTUALIZAR ÚNICAMENTE EL ID_MODALIDAD EN LA TABLA OCURRENCIA_REGISTRO
      await connection.query(
        `UPDATE ocurrencia_registro 
       SET id_modalidad = ? 
       WHERE id_ocurrencia = ?`,
        [id_modalidad, id_ocurrencia],
      );

      // 4. INSERTAR EN LA TABLA DETALLE DE AGRESORES
      await connection.query(
        `INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, placa_agresor, edad) 
       VALUES (?, ?, ?, ?)`,
        [id_ocurrencia, nombre_agresor, placa_agresor, edad],
      );

      await connection.commit();
      res.status(200).json({
        success: true,
        message: "MODALIDAD ACTUALIZADA Y AGRESOR REGISTRADO CORRECTAMENTE",
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error("🔴 ERROR AL EDITAR MODALIDAD:", error.message);
      res
        .status(400)
        .json({ success: false, error: error.message.toUpperCase() });
    } finally {
      if (connection) connection.release();
    }
  },
);
// --- PROGRAMACIÓN (CRON) ---
app.put(
  "/ocurrencias/editarseguro2-sipcop/:id_ocurrencia",
  async (req, res) => {
    let connection;
    try {
      const { id_ocurrencia } = req.params;
      const { id_modalidad, victimas, agresores } = req.body;

      // VALIDAR QUE EL ID DE MODALIDAD NO ESTÉ VACÍO O NULO
      if (
        id_modalidad === undefined ||
        id_modalidad === null ||
        id_modalidad === ""
      ) {
        return res.status(400).json({
          success: false,
          error: "EL ID DE MODALIDAD ES OBLIGATORIO",
        });
      }

      connection = await db.getConnection();
      await connection.beginTransaction();

      // 1. VERIFICAR SI LA OCURRENCIA REALMENTE EXISTE
      const [rows] = await connection.query(
        `SELECT id_ocurrencia FROM ocurrencia_registro WHERE id_ocurrencia = ?`,
        [id_ocurrencia],
      );

      if (!rows || rows.length === 0) {
        throw new Error("LA OCURRENCIA NO EXISTE");
      }

      // 2. VERIFICAR SI LA MODALIDAD EXISTE EN EL CATÁLOGO
      const [modalidadRows] = await connection.query(
        `SELECT id FROM cat_modalidad WHERE id = ?`,
        [id_modalidad],
      );

      if (!modalidadRows || modalidadRows.length === 0) {
        throw new Error("LA MODALIDAD SELECCIONADA NO ES VÁLIDA");
      }

      // 3. ACTUALIZAR ÚNICAMENTE LA MODALIDAD EN LA TABLA OCURRENCIA_REGISTRO
      await connection.query(
        `UPDATE ocurrencia_registro 
       SET id_modalidad = ? 
       WHERE id_ocurrencia = ?`,
        [id_modalidad, id_ocurrencia],
      );

      // 4. INSERTAR VÍCTIMAS (INCLUYENDO EL id_relacion_v SELECCIONADO)
      if (Array.isArray(victimas) && victimas.length > 0) {
        for (const vic of victimas) {
          await connection.query(
            `INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, placa_victima, edad, id_relacion_v) 
           VALUES (?, ?, ?, ?, ?)`,
            [
              id_ocurrencia,
              vic.nombre_victima || null,
              vic.placa_victima || null,
              vic.edad || null,
              vic.id_relacion_v || null,
            ],
          );
        }
      }

      // 5. INSERTAR AGRESORES (SI SE AGREGARON)
      if (Array.isArray(agresores) && agresores.length > 0) {
        for (const agr of agresores) {
          await connection.query(
            `INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, placa_agresor, edad) 
           VALUES (?, ?, ?, ?)`,
            [
              id_ocurrencia,
              agr.nombre_agresor || null,
              agr.placa_agresor || null,
              agr.edad || null,
            ],
          );
        }
      }

      await connection.commit();
      res.status(200).json({
        success: true,
        message: "REGISTRO ACTUALIZADO CORRECTAMENTE",
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error("🔴 ERROR AL EDITAR OCURRENCIA:", error.message);
      res
        .status(400)
        .json({ success: false, error: error.message.toUpperCase() });
    } finally {
      if (connection) connection.release();
    }
  },
);
// --- ADICIONAR 4 CAMPOS EDITAR DEL SIPCOP ---
app.put(
  "/ocurrencias/editarseguro-sipcop4/:id_ocurrencia",
  async (req, res) => {
    let connection;
    try {
      const { id_ocurrencia } = req.params;

      console.log("📥 REQ.BODY RECIBIDO:", JSON.stringify(req.body, null, 2));

      const {
        id_modalidad,
        id_resultado_real,
        id_resultado,
        id_consecuencia_real,
        id_consecuencia,
        id_lugar_real,
        id_lugarsip,
        id_medio_real,
        id_medio,
        victimas,
        agresores,
      } = req.body;

      // RESOLVER EL VALOR FINAL (Si no se manda el campo, toma null)
      const finalModalidad =
        id_modalidad !== undefined && id_modalidad !== "" ? id_modalidad : null;
      const finalResultado =
        id_resultado_real !== undefined ? id_resultado_real : id_resultado;
      const finalConsecuencia =
        id_consecuencia_real !== undefined
          ? id_consecuencia_real
          : id_consecuencia;
      const finalLugar =
        id_lugar_real !== undefined ? id_lugar_real : id_lugarsip;
      const finalMedio = id_medio_real !== undefined ? id_medio_real : id_medio;

      connection = await db.getConnection();
      await connection.beginTransaction();

      // 1. VERIFICAR SI LA OCURRENCIA REALMENTE EXISTE
      const [rows] = await connection.query(
        `SELECT id_ocurrencia FROM ocurrencia_registro WHERE id_ocurrencia = ?`,
        [id_ocurrencia],
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "LA OCURRENCIA NO EXISTE",
        });
      }

      // 2. VALIDAR MODALIDAD SOLO SI EL USUARIO LA HA ENVIADO
      if (finalModalidad !== null) {
        const [modalidadRows] = await connection.query(
          `SELECT id FROM cat_modalidad WHERE id = ?`,
          [finalModalidad],
        );
        if (!modalidadRows || modalidadRows.length === 0) {
          return res.status(400).json({
            success: false,
            error: "LA MODALIDAD SELECCIONADA NO ES VÁLIDA",
          });
        }
      }

      // PARÁMETROS PARA EL UPDATE PARCIAL
      const paramsUpdate = [
        finalModalidad,
        finalResultado !== undefined && finalResultado !== ""
          ? finalResultado
          : null,
        finalConsecuencia !== undefined && finalConsecuencia !== ""
          ? finalConsecuencia
          : null,
        finalLugar !== undefined && finalLugar !== "" ? finalLugar : null,
        finalMedio !== undefined && finalMedio !== "" ? finalMedio : null,
        id_ocurrencia,
      ];

      console.log("🔄 PARÁMETROS PARA EL UPDATE PARCIAL:", paramsUpdate);

      // 3. ACTUALIZAR USANDO COALESCE (SI EL NUEVO VALOR ES NULO, MANTIENE EL ANTERIOR)
      await connection.query(
        `UPDATE ocurrencia_registro 
       SET id_modalidad = COALESCE(?, id_modalidad), 
           id_resultado_real = COALESCE(?, id_resultado_real), 
           id_consecuencia_real = COALESCE(?, id_consecuencia_real), 
           id_lugar_real = COALESCE(?, id_lugar_real), 
           id_medio_real = COALESCE(?, id_medio_real) 
       WHERE id_ocurrencia = ?`,
        paramsUpdate,
      );

      // 4. GESTIÓN DE VÍCTIMAS (Solo borrar e insertar si el array viene definido y trae elementos,
      // o si prefieres reemplazarlo por completo solo cuando el usuario interactúe con él)
      if (Array.isArray(victimas)) {
        await connection.query(
          `DELETE FROM detalle_victimas_ocurrencia WHERE id_ocurrencia = ?`,
          [id_ocurrencia],
        );
        if (victimas.length > 0) {
          for (const vic of victimas) {
            await connection.query(
              `INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, placa_victima, edad, id_relacion_v) 
             VALUES (?, ?, ?, ?, ?)`,
              [
                id_ocurrencia,
                vic.nombre_victima || null,
                vic.placa_victima || null,
                vic.edad || null,
                vic.id_relacion_v || null,
              ],
            );
          }
        }
      }

      // 5. GESTIÓN DE AGRESORES
      if (Array.isArray(agresores)) {
        await connection.query(
          `DELETE FROM detalle_agresores_ocurrencia WHERE id_ocurrencia = ?`,
          [id_ocurrencia],
        );
        if (agresores.length > 0) {
          for (const agr of agresores) {
            await connection.query(
              `INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, placa_agresor, edad) 
             VALUES (?, ?, ?, ?)`,
              [
                id_ocurrencia,
                agr.nombre_agresor || null,
                agr.placa_agresor || null,
                agr.edad || null,
              ],
            );
          }
        }
      }

      await connection.commit();
      console.log(
        "✅ TRANSACCIÓN EXITOSA: REGISTRO ACTUALIZADO DE FORMA PERSISTENTE.",
      );
      return res.status(200).json({
        success: true,
        message: "REGISTRO ACTUALIZADO CORRECTAMENTE",
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error("🔴 ERROR CRÍTICO AL EDITAR OCURRENCIA:", error.message);
      return res.status(500).json({
        success: false,
        error: error.message.toUpperCase(),
      });
    } finally {
      if (connection) connection.release();
    }
  },
);

// --- ADICIONAR 5 CAMPOS EDITAR DEL SIPCOP ---
app.put("/ocurrencias/editarseguro-sipcop/:id_ocurrencia", async (req, res) => {
  let connection;
  try {
    const { id_ocurrencia } = req.params;

    console.log("📥 REQ.BODY RECIBIDO:", JSON.stringify(req.body, null, 2));

    const {
      id_modalidad,
      id_resultado_real,
      id_resultado,
      id_consecuencia_real,
      id_consecuencia,
      id_lugar_real,
      id_lugarsip,
      id_medio_real,
      id_medio,
      victimas,
      agresores,
      estado, // <--- NUEVO CAMPO
      patrimonio_real, // <--- NUEVO CAMPO
      arresto_ciudadano, // <--- NUEVO CAMPO
    } = req.body;

    // RESOLVER EL VALOR FINAL (Si no se manda el campo, toma null)
    const finalModalidad =
      id_modalidad !== undefined && id_modalidad !== "" ? id_modalidad : null;
    const finalResultado =
      id_resultado_real !== undefined ? id_resultado_real : id_resultado;
    const finalConsecuencia =
      id_consecuencia_real !== undefined
        ? id_consecuencia_real
        : id_consecuencia;
    const finalLugar =
      id_lugar_real !== undefined ? id_lugar_real : id_lugarsip;
    const finalMedio = id_medio_real !== undefined ? id_medio_real : id_medio;

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. VERIFICAR SI LA OCURRENCIA REALMENTE EXISTE
    const [rows] = await connection.query(
      `SELECT id_ocurrencia FROM ocurrencia_registro WHERE id_ocurrencia = ?`,
      [id_ocurrencia],
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "LA OCURRENCIA NO EXISTE",
      });
    }

    // 2. VALIDAR MODALIDAD SOLO SI EL USUARIO LA HA ENVIADO
    if (finalModalidad !== null) {
      const [modalidadRows] = await connection.query(
        `SELECT id FROM cat_modalidad WHERE id = ?`,
        [finalModalidad],
      );
      if (!modalidadRows || modalidadRows.length === 0) {
        return res.status(400).json({
          success: false,
          error: "LA MODALIDAD SELECCIONADA NO ES VÁLIDA",
        });
      }
    }

    // PARÁMETROS PARA EL UPDATE PARCIAL
    const paramsUpdate = [
      finalModalidad,
      finalResultado !== undefined && finalResultado !== ""
        ? finalResultado
        : null,
      finalConsecuencia !== undefined && finalConsecuencia !== ""
        ? finalConsecuencia
        : null,
      finalLugar !== undefined && finalLugar !== "" ? finalLugar : null,
      finalMedio !== undefined && finalMedio !== "" ? finalMedio : null,
      estado !== undefined && estado !== "" ? estado : null,
      patrimonio_real !== undefined && patrimonio_real !== ""
        ? patrimonio_real
        : null,
      arresto_ciudadano !== undefined && arresto_ciudadano !== ""
        ? arresto_ciudadano
        : null,
      id_ocurrencia,
    ];

    console.log("🔄 PARÁMETROS PARA EL UPDATE PARCIAL:", paramsUpdate);

    // 3. ACTUALIZAR USANDO COALESCE (SI EL NUEVO VALOR ES NULO, MANTIENE EL ANTERIOR)
    await connection.query(
      `UPDATE ocurrencia_registro 
       SET id_modalidad = COALESCE(?, id_modalidad), 
           id_resultado_real = COALESCE(?, id_resultado_real), 
           id_consecuencia_real = COALESCE(?, id_consecuencia_real), 
           id_lugar_real = COALESCE(?, id_lugar_real), 
           id_medio_real = COALESCE(?, id_medio_real),
           estado = COALESCE(?, estado),
           patrimonio_real = COALESCE(?, patrimonio_real),
           arresto_ciudadano = COALESCE(?, arresto_ciudadano),
           fecha_ultima_edicion = NULL 
       WHERE id_ocurrencia = ?`,
      paramsUpdate,
    );

    // 4. GESTIÓN DE VÍCTIMAS
    if (Array.isArray(victimas)) {
      await connection.query(
        `DELETE FROM detalle_victimas_ocurrencia WHERE id_ocurrencia = ?`,
        [id_ocurrencia],
      );
      if (victimas.length > 0) {
        for (const vic of victimas) {
          await connection.query(
            `INSERT INTO detalle_victimas_ocurrencia (id_ocurrencia, nombre_victima, placa_victima, edad, id_relacion_v) 
             VALUES (?, ?, ?, ?, ?)`,
            [
              id_ocurrencia,
              vic.nombre_victima || null,
              vic.placa_victima || null,
              vic.edad || null,
              vic.id_relacion_v || null,
            ],
          );
        }
      }
    }
    // graficos

    // 5. GESTIÓN DE AGRESORES
    if (Array.isArray(agresores)) {
      await connection.query(
        `DELETE FROM detalle_agresores_ocurrencia WHERE id_ocurrencia = ?`,
        [id_ocurrencia],
      );
      if (agresores.length > 0) {
        for (const agr of agresores) {
          await connection.query(
            `INSERT INTO detalle_agresores_ocurrencia (id_ocurrencia, nombre_agresor, placa_agresor, edad) 
             VALUES (?, ?, ?, ?)`,
            [
              id_ocurrencia,
              agr.nombre_agresor || null,
              agr.placa_agresor || null,
              agr.edad || null,
            ],
          );
        }
      }
    }

    await connection.commit();
    console.log(
      "✅ TRANSACCIÓN EXITOSA: REGISTRO ACTUALIZADO DE FORMA PERSISTENTE.",
    );
    return res.status(200).json({
      success: true,
      message: "REGISTRO ACTUALIZADO CORRECTAMENTE",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("🔴 ERROR CRÍTICO AL EDITAR OCURRENCIA:", error.message);
    return res.status(500).json({
      success: false,
      error: error.message.toUpperCase(),
    });
  } finally {
    if (connection) connection.release();
  }
});



/* jemplo para bd 
const getFiltroDinamico = (req) => {
  const { id_origen, id_tipop } = req.query;

  let filtro = "";
  let params = [];

  filtro = `
    WHERE 
      (
        -- TURNO 1 (07:00 - 15:00)
        (CURRENT_TIME() >= '07:00:00' AND CURRENT_TIME() < '15:00:00' 
         AND o.fecha_evento = CURDATE() 
         AND o.hora_repliegue >= '07:00:00' AND o.hora_repliegue < '15:00:00')
        
        OR 
        
        -- TURNO 2 (15:00 - 22:00)
        (CURRENT_TIME() >= '15:00:00' AND CURRENT_TIME() < '22:00:00' 
         AND o.fecha_evento = CURDATE() 
         AND o.hora_repliegue >= '15:00:00' AND o.hora_repliegue < '22:00:00')
        
        OR 
        
        -- TURNO 3 - PARTE NOCHE (22:00 a 23:59): Como ahorita estamos a las 23:xx hrs, 
        -- busca estrictamente los eventos de HOY a partir de las 22:00 hrs en adelante.
        (CURRENT_TIME() >= '22:00:00' 
         AND o.fecha_evento = CURDATE() 
         AND o.hora_repliegue >= '22:00:00'
        )

        OR 
        
        -- TURNO 3 - PARTE MADRUGADA (00:00 a 07:00): Si estuvieras en la madrugada (ej. a las 3:00 AM), 
        -- ahí sí busca lo que empezó AYER a las 22:00 o HOY antes de las 07:00.
        (CURRENT_TIME() < '07:00:00' 
         AND (
           (o.fecha_evento = CURDATE() - INTERVAL 1 DAY AND o.hora_repliegue >= '22:00:00')
           OR 
           (o.fecha_evento = CURDATE() AND o.hora_repliegue < '07:00:00')
         )
        )
      )
      -- Evita traer eventos futuros respecto al momento exacto
      AND TIMESTAMP(o.fecha_evento, o.hora_repliegue) <= NOW()
  `;

  if (id_origen && id_origen !== 'TODOS') {
    filtro += ` AND o.id_origen = ? `;
    params.push(id_origen);
  }
  if (id_tipop && id_tipop !== 'TODOS') {
    filtro += ` AND o.id_tipop = ? `;
    params.push(id_tipop);
  }

  return { filtro, params };
};
*/
app.get("/ocurrencias/catalogos-filtros", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const [origenes] = await connection.query("SELECT id_origen, descripcion FROM origen");
    const [tiposPatrullaje] = await connection.query("SELECT id_tipop, nombre FROM tipo_patrullaje");
    
    res.json({
      success: true,
      origenes,
      tipos_patrullaje: tiposPatrullaje
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
const getFiltroDinamico = (req) => {
  const { id_origen, id_tipop, id_tipo_vehiculo } = req.query;

  let filtro = "";
  let params = [];

  filtro = `
    WHERE (
      -- Turno Mañana (hoy)
      (CURRENT_TIME() >= '07:00:00' AND CURRENT_TIME() < '15:00:00' AND o.fechar = CURDATE() AND o.turnr = 'm')
      OR
      -- Turno Tarde (hoy)
      (CURRENT_TIME() >= '15:00:00' AND CURRENT_TIME() < '22:00:00' AND o.fechar = CURDATE() AND o.turnr = 't')
      OR
      -- Turno Noche parte inicial (hoy a partir de las 22:00)
      (CURRENT_TIME() >= '22:00:00' AND o.fechar = CURDATE() AND o.turnr = 'n')
      OR
      -- Turno Noche parte madrugada (de 00:00 a 07:00, donde tu trigger restó un día)
      (CURRENT_TIME() < '07:00:00' AND o.fechar = CURDATE() - INTERVAL 1 DAY AND o.turnr = 'n')
    )
    AND TIMESTAMP(o.fechar, o.hora_repliegue) <= NOW()
  `;

  if (id_origen && id_origen !== 'TODOS') {
    filtro += ` AND o.id_origen = ? `;
    params.push(id_origen);
  }
  if (id_tipop && id_tipop !== 'TODOS') {
    filtro += ` AND o.id_tipop = ? `;
    params.push(id_tipop);
  }
  // 📌 AQUÍ ESTABA FALTANDO EL FILTRO POR TIPO DE VEHÍCULO
  if (id_tipo_vehiculo && id_tipo_vehiculo !== 'TODOS') {
    filtro += ` AND ov_filtro.id_tipo_vehiculo = ? `;
    params.push(id_tipo_vehiculo);
  }

  return { filtro, params };
};

// Estadísticas generales para las tarjetas (con el JOIN necesario para el filtro de vehículo)
app.get("/ocurrencias/estadisticas", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const { filtro, params } = getFiltroDinamico(req);

    const sqlUsuarios = `
      SELECT 
        us.id_usuario AS id,
        COALESCE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres), 'Sin asignar') AS label,
        COUNT(o.id_ocurrencia) AS value
      FROM ocurrencia_registro o
      LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
      LEFT JOIN persona p ON us.id_persona = p.id_persona
      LEFT JOIN ocurrencia_vehiculo_detalle ov_filtro ON o.id_ocurrencia = ov_filtro.id_ocurrencia
      ${filtro}
      GROUP BY us.id_usuario, p.apellido_paterno, p.apellido_materno, p.nombres
      ORDER BY value DESC;
    `;

    const sqlModalidades = `
      SELECT 
        COALESCE(m.nombre, 'Sin modalidad') AS label,
        COUNT(o.id_ocurrencia) AS value
      FROM ocurrencia_registro o
      LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
      LEFT JOIN ocurrencia_vehiculo_detalle ov_filtro ON o.id_ocurrencia = ov_filtro.id_ocurrencia
      ${filtro}
      GROUP BY m.id, m.nombre
      ORDER BY value DESC;
    `;

    const [usuariosRows] = await connection.query(sqlUsuarios, params);
    const [modalidadesRows] = await connection.query(sqlModalidades, params);

    res.json({ success: true, por_usuario: usuariosRows, por_modalidad: modalidadesRows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/modalidades-por-usuario", async (req, res) => {
  const { id_usuario } = req.query; 
  if (!id_usuario) return res.status(400).json({ success: false, error: "Falta id_usuario" });

  let connection;
  try {
    connection = await db.getConnection();
    const { filtro, params } = getFiltroDinamico(req);
    const [rows] = await connection.query(`
      SELECT COALESCE(m.nombre, 'Sin modalidad') AS modalidad, COUNT(o.id_ocurrencia) AS cantidad
      FROM ocurrencia_registro o
      LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
      LEFT JOIN ocurrencia_vehiculo_detalle ov_filtro ON o.id_ocurrencia = ov_filtro.id_ocurrencia
      ${filtro} AND o.id_usuario = ?
      GROUP BY m.id, m.nombre ORDER BY cantidad DESC;
    `, [...params, id_usuario]);
    res.json({ success: true, modalidades: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/detalle-por-modalidad", async (req, res) => {
  const { id_usuario, modalidad } = req.query;
  if (!id_usuario || !modalidad) return res.status(400).json({ success: false, error: "Faltan parámetros" });

  let connection;
  try {
    connection = await db.getConnection();
    const { filtro, params } = getFiltroDinamico(req);
    const [rows] = await connection.query(`
      SELECT 
        COALESCE(m.nombre, 'Sin modalidad') AS MODALIDAD, 
        COALESCE(TRIM(l.nombre_lugar), 'Sin dirección registrada') AS DIRECCIÓN_CONSOLIDADA,
        COUNT(o.id_ocurrencia) AS CANTIDAD
      FROM ocurrencia_registro o 
      LEFT JOIN lugar l ON o.id_lugar = l.id_lugar 
      LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
      LEFT JOIN ocurrencia_vehiculo_detalle ov_filtro ON o.id_ocurrencia = ov_filtro.id_ocurrencia
      ${filtro} AND o.id_usuario = ?
      AND (TRIM(m.nombre) = TRIM(?) OR (? = 'Sin modalidad' && m.nombre IS NULL))
      GROUP BY COALESCE(TRIM(l.nombre_lugar), 'Sin dirección registrada'), m.nombre
      ORDER BY CANTIDAD DESC;
    `, [...params, id_usuario, modalidad, modalidad]);
    res.json({ success: true, direcciones: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/vehiculos-por-usuario", async (req, res) => {
  const { id_usuario } = req.query; 
  if (!id_usuario) return res.status(400).json({ success: false, error: "Falta id_usuario" });

  let connection;
  try {
    connection = await db.getConnection();
    const { filtro, params } = getFiltroDinamico(req);
    
    const [rows] = await connection.query(`
      SELECT 
        COALESCE(tv.descripcion, 'Sin vehículo') AS tipo_vehiculo, 
        COUNT(o.id_ocurrencia) AS cantidad
      FROM ocurrencia_registro o
      LEFT JOIN ocurrencia_vehiculo_detalle ov ON o.id_ocurrencia = ov.id_ocurrencia
      LEFT JOIN tipo_vehiculo tv ON ov.id_tipo_vehiculo = tv.id_tipo_vehiculo
      LEFT JOIN ocurrencia_vehiculo_detalle ov_filtro ON o.id_ocurrencia = ov_filtro.id_ocurrencia
      ${filtro} AND o.id_usuario = ?
      GROUP BY tv.id_tipo_vehiculo, tv.descripcion 
      ORDER BY cantidad DESC;
    `, [...params, id_usuario]);

    res.json({ success: true, vehiculos: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/ocurrencias/detalle-por-vehiculo", async (req, res) => {
  const { id_usuario, tipo_vehiculo } = req.query;
  if (!id_usuario || !tipo_vehiculo) return res.status(400).json({ success: false, error: "Faltan parámetros" });

  let connection;
  try {
    connection = await db.getConnection();
    const { filtro, params } = getFiltroDinamico(req);
    
    const [rows] = await connection.query(`
      SELECT 
        COALESCE(tv.descripcion, 'Sin vehículo') AS TIPO_VEHICULO, 
        COALESCE(TRIM(l.nombre_lugar), 'Sin dirección registrada') AS DIRECCIÓN_CONSOLIDADA,
        COUNT(o.id_ocurrencia) AS CANTIDAD
      FROM ocurrencia_registro o 
      LEFT JOIN lugar l ON o.id_lugar = l.id_lugar 
      LEFT JOIN ocurrencia_vehiculo_detalle ov ON o.id_ocurrencia = ov.id_ocurrencia
      LEFT JOIN tipo_vehiculo tv ON ov.id_tipo_vehiculo = tv.id_tipo_vehiculo
      LEFT JOIN ocurrencia_vehiculo_detalle ov_filtro ON o.id_ocurrencia = ov_filtro.id_ocurrencia
      ${filtro} AND o.id_usuario = ?
      AND (TRIM(tv.descripcion) = TRIM(?) OR (? = 'Sin vehículo' && tv.descripcion IS NULL))
      GROUP BY COALESCE(TRIM(l.nombre_lugar), 'Sin dirección registrada'), tv.descripcion
      ORDER BY CANTIDAD DESC;
    `, [...params, id_usuario, tipo_vehiculo, tipo_vehiculo]);

    res.json({ success: true, direcciones: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});


app.get("/ocurrencias/estadisticas-mensuales3", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    const mes = req.query.mes || new Date().getMonth() + 1;
    const anio = req.query.anio || new Date().getFullYear();
    const idModalidad = req.query.id_modalidad;

    // Filtros basados en 'fechar' (Ajustado exactamente con la lógica del trigger)
    let whereClause = `WHERE MONTH(o.fechar) = ? AND YEAR(o.fechar) = ?`;
    let queryParams = [mes, anio];

    if (idModalidad) {
      whereClause += ` AND o.id_modalidad = ?`;
      queryParams.push(idModalidad);
    }

    // 1. Evolución diaria desglosada por turno usando 'fechar'
    const sqlDiarioTurnos = `
      SELECT 
        DAY(o.fechar) AS dia,
        o.turnrm AS turno,
        COUNT(o.id_ocurrencia) AS total
      FROM ocurrencia_registro o
      ${whereClause} AND o.turnrm IN ('M', 'T', 'N')
      GROUP BY DAY(o.fechar), o.turnrm
      ORDER BY dia ASC;
    `;

    // 2. Matriz de usuarios agrupada por fechar, turno y modalidad (Incluyendo JOIN con cat_modalidad)
    const sqlMatrizUsuarios = `
      SELECT 
        COALESCE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres), 'Sin asignar') AS usuario,
        DAY(o.fechar) AS dia,
        o.turnrm AS turno,
        o.id_modalidad,
        COALESCE(m.nombre, 'SIN MODALIDAD') AS nombre_modalidad,
        COUNT(o.id_ocurrencia) AS total
      FROM ocurrencia_registro o
      LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
      LEFT JOIN persona p ON us.id_persona = p.id_persona
      LEFT JOIN cat_modalidad m ON o.id_modalidad = m.id
      ${whereClause}
      GROUP BY us.id_usuario, p.apellido_paterno, p.apellido_materno, p.nombres, DAY(o.fechar), o.turnrm, o.id_modalidad, m.nombre
      ORDER BY usuario ASC;
    `;

    // 3. Totales generales del mes usando 'fechar'
    const sqlTotalesMes = `
      SELECT 
        COUNT(o.id_ocurrencia) AS total_mes,
        SUM(CASE WHEN o.turnrm = 'M' THEN 1 ELSE 0 END) AS total_mañana,
        SUM(CASE WHEN o.turnrm = 'T' THEN 1 ELSE 0 END) AS total_tarde,
        SUM(CASE WHEN o.turnrm = 'N' THEN 1 ELSE 0 END) AS total_noche
      FROM ocurrencia_registro o
      ${whereClause};
    `;

    const [modalidadesRows] = await connection.query(`SELECT id, nombre FROM cat_modalidad ORDER BY nombre ASC`);
    const [diarioRows] = await connection.query(sqlDiarioTurnos, queryParams);
    const [matrizRows] = await connection.query(sqlMatrizUsuarios, queryParams);
    const [totalesRows] = await connection.query(sqlTotalesMes, queryParams);

    res.json({
      success: true,
      evolucion_diaria_turnos: diarioRows,
      matriz_usuarios: matrizRows,
      totales_mes: totalesRows[0] || { total_mes: 0, total_mañana: 0, total_tarde: 0, total_noche: 0 },
      modalidades_catalogo: modalidadesRows,
    });
  } catch (error) {
    console.error("ERROR EN /ocurrencias/estadisticas-mensuales:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});



app.get("/ocurrencias/estadisticas-mensuales1", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();

    // Capturar mes, año y filtros opcionales enviados desde la app
    const mes = req.query.mes || new Date().getMonth() + 1;
    const anio = req.query.anio || new Date().getFullYear();
    const idModalidad = req.query.id_modalidad; // Opcional
    const origen = req.query.origen; // Opcional (ej. tipo de patrullaje si aplica en tu BD)

    // Construir filtros dinámicos
    let whereClause = `WHERE MONTH(o.fecha_reporte) = ? AND YEAR(o.fecha_reporte) = ?`;
    let queryParams = [mes, anio];

    if (idModalidad) {
      whereClause += ` AND o.id_modalidad = ?`;
      queryParams.push(idModalidad);
    }

    if (origen) {
      whereClause += ` AND o.origen = ?`; // Ajusta el campo según tu tabla si existe
      queryParams.push(origen);
    }

    // Consulta para el gráfico diario
    const sqlDiario = `
      SELECT 
        DATE(o.fecha_reporte) AS fecha,
        DAY(o.fecha_reporte) AS dia,
        COUNT(o.id_ocurrencia) AS total
      FROM ocurrencia_registro o
      ${whereClause}
      GROUP BY DATE(o.fecha_reporte), DAY(o.fecha_reporte)
      ORDER BY fecha ASC;
    `;

    // Consulta desglosada por usuario y día para la matriz
    const sqlMatrizUsuarios = `
      SELECT 
        COALESCE(CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres), 'Sin asignar') AS usuario,
        DAY(o.fecha_reporte) AS dia,
        COUNT(o.id_ocurrencia) AS total
      FROM ocurrencia_registro o
      LEFT JOIN usuarios_sistema us ON o.id_usuario = us.id_usuario 
      LEFT JOIN persona p ON us.id_persona = p.id_persona
      ${whereClause}
      GROUP BY us.id_usuario, p.apellido_paterno, p.apellido_materno, p.nombres, DAY(o.fecha_reporte)
      ORDER BY total DESC;
    `;

    // Obtener catálogo de modalidades para los filtros del frontend
    const [modalidadesRows] = await connection.query(`SELECT id, nombre FROM cat_modalidad ORDER BY nombre ASC`);
    
    const [diarioRows] = await connection.query(sqlDiario, queryParams);
    const [matrizRows] = await connection.query(sqlMatrizUsuarios, queryParams);

    res.json({
      success: true,
      evolucion_diaria: diarioRows,
      matriz_usuarios: matrizRows,
      modalidades_catalogo: modalidadesRows,
    });
  } catch (error) {
    console.error("ERROR EN /ocurrencias/estadisticas-mensuales:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// Endpoint para el Contador 1: El Total Total Total del Periodo (Ej. 6k)
// Endpoint exclusivo para el Contador 1 (Total absoluto del turno, libre de filtros de usuario/origen)
app.get("/ocurrencias/total-turno", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    
    const ahora = new Date();
    const tiempoMinutos = ahora.getHours() * 60 + ahora.getMinutes();

    let filtroTiempo = "";

    // Mantiene la misma lógica de tiempo de tus turnos, pero SIN tocar id_origen ni id_tipop
    if (tiempoMinutos >= 430 && tiempoMinutos < 900) {
      filtroTiempo = `WHERE o.fecha_evento = CURDATE() AND o.hora_repliegue >= '07:00:00' AND o.hora_repliegue < '15:00:00'`;
    } else if (tiempoMinutos >= 900 && tiempoMinutos < 1320) {
      filtroTiempo = `WHERE o.fecha_evento = CURDATE() AND o.hora_repliegue >= '15:00:00' AND o.hora_repliegue < '22:00:00'`;
    } else {
      filtroTiempo = `
        WHERE TIMESTAMP(o.fecha_evento, o.hora_repliegue) >= TIMESTAMP(CURDATE() - INTERVAL 1 DAY, '22:00:00')
          AND TIMESTAMP(o.fecha_evento, o.hora_repliegue) < TIMESTAMP(CURDATE(), '07:00:00')
      `;
    }

    filtroTiempo += ` AND TIMESTAMP(o.fecha_evento, o.hora_repliegue) <= NOW()`;

    const sqlTotal = `SELECT COUNT(o.id_ocurrencia) AS total FROM ocurrencia_registro o ${filtroTiempo}`;
    
    const [rows] = await connection.query(sqlTotal);
    res.json({ success: true, total: rows[0]?.total || 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
});
app.get("/mapa-completoseg", async (req, res) => {
  try {
    // 1. Obtener los polígonos de la PNP
    const queryPoligonos = `
      SELECT 
        nombre_cuadrante as nombre, 
        ST_AsGeoJSON(ST_Simplify(area_poligono, 0.0001)) as geometria, 
        'pnp' as fuente 
      FROM pnp_poligono_gis
    `;
    const [poligonos] = await db.query(queryPoligonos);

    // 2. Obtener los lugares usando tu consulta exacta, renombrando codigo_cuadrante como id_pnp_cuadrante
    const queryPuntos = `
      SELECT 
        l.id_lugar AS id, 
        l.nombre_lugar, 
        l.direccion, 
        l.latitud, 
        l.longitud, 
        pnc.codigo_cuadrante AS id_pnp_cuadrante, -- <-- AQUÍ ESTÁ EL CAMBIO CLAVE
        tl.nombre_tipo AS tipo_lugar
      FROM lugar l
      INNER JOIN tipos_lugar tl ON tl.id_tipo = l.id_tipo_lugar 
      INNER JOIN pnp_cuadrante AS pnc ON pnc.id_pnp_cuadrante = l.id_pnp_cuadrante
      WHERE l.estado = 1 
        AND l.latitud IS NOT NULL 
        AND l.longitud IS NOT NULL 
        AND l.id_tipo_lugar IN (1, 2, 3);
    `;
    const [puntos] = await db.query(queryPuntos);

    // Parsear geometrías de polígonos
    const poligonosParseados = poligonos.map((fila) => ({
      ...fila,
      geometria: typeof fila.geometria === "string" ? JSON.parse(fila.geometria) : fila.geometria,
    }));

    res.json({
      poligonos: poligonosParseados,
      puntos: puntos
    });

  } catch (error) {
    console.error("Error en /mapa-completo:", error);
    res.status(500).json({ error: error.message });
  }
});


// Caché en la memoria RAM del servidor para el mapa completo
let cacheMapaCompleto = {
    data: null,
    timestamp: 0
};
const CACHE_TTL_MAPA = 10 * 60 * 1000; // 10 minutos de caché

app.get("/mapa-completo", async (req, res) => {
  const ahora = Date.now();

  // 1. Si la caché sigue vigente, la entregamos al instante sin tocar MySQL
  if (cacheMapaCompleto.data && (ahora - cacheMapaCompleto.timestamp < CACHE_TTL_MAPA)) {
    console.log("[CACHÉ] Entregando /mapa-completo desde memoria RAM (Cero carga en MySQL)");
    return res.json(cacheMapaCompleto.data);
  }

  try {
    // 1. Obtener los polígonos de la PNP
    const queryPoligonos = `
      SELECT 
        nombre_cuadrante as nombre, 
        ST_AsGeoJSON(ST_Simplify(area_poligono, 0.0001)) as geometria, 
        'pnp' as fuente 
      FROM pnp_poligono_gis
    `;
    const [poligonos] = await db.query(queryPoligonos);

    // 2. Obtener los lugares
    const queryPuntos = `
      SELECT 
        l.id_lugar AS id, 
        l.nombre_lugar, 
        l.direccion, 
        l.latitud, 
        l.longitud, 
        pnc.codigo_cuadrante AS id_pnp_cuadrante, 
        tl.nombre_tipo AS tipo_lugar
      FROM lugar l
      INNER JOIN tipos_lugar tl ON tl.id_tipo = l.id_tipo_lugar 
      INNER JOIN pnp_cuadrante AS pnc ON pnc.id_pnp_cuadrante = l.id_pnp_cuadrante
      WHERE l.estado = 1 
        AND l.latitud IS NOT NULL 
        AND l.longitud IS NOT NULL 
        AND l.id_tipo_lugar IN (1, 2, 3);
    `;
    const [puntos] = await db.query(queryPuntos);

    // 3. Obtener las cámaras
    const queryCamaras = `
      SELECT 
        c.id_camara AS id,
        c.codigo_camara,
        c.nombre_camara, 
        c.ubicacion_referencia AS direccion,
        c.lat AS latitud,
        c.lon AS longitud,
        pnc.codigo_cuadrante AS id_pnp_cuadrante,
        c.proveedor,
        'CÁMARA DE VIDEO' AS tipo_lugar
      FROM camara c
      LEFT JOIN pnp_cuadrante AS pnc ON pnc.id_pnp_cuadrante = c.id_pnp_cuadrante
      WHERE c.estado = 1 
        AND c.lat IS NOT NULL 
        AND c.lon IS NOT NULL;
    `;
    const [camaras] = await db.query(queryCamaras);

    // Parsear geometrías de polígonos
    const poligonosParseados = poligonos.map((fila) => ({
      ...fila,
      geometria: typeof fila.geometria === "string" ? JSON.parse(fila.geometria) : fila.geometria,
    }));

    // Formatear cámaras para que unifiquen sus nombres correctamente
    const camarasFormateadas = camaras.map(c => ({
      ...c,
      nombre_lugar: `Cámara: ${c.nombre_camara || c.codigo_camara} (${c.proveedor || 'S/P'})`
    }));

    const respuestaFinal = {
      poligonos: poligonosParseados,
      puntos: [...puntos, ...camarasFormateadas]
    };

    // 2. Guardar en la caché antes de responder
    cacheMapaCompleto = {
      data: respuestaFinal,
      timestamp: ahora
    };

    console.log("[MYSQL] Consultando base de datos para /mapa-completo");
    res.json(respuestaFinal);

  } catch (error) {
    console.error("Error en /mapa-completo:", error);
    res.status(500).json({ error: error.message });
  }
});
const PUERTO_APP = process.env.PORT || 3000;
app.listen(PUERTO_APP, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PUERTO_APP}`);
});