const mysql = require("mysql2/promise");

async function generarOcurrenciasMasivas() {
  const connection = await mysql.createConnection({
    host: "localhost",
    port: 8889, // Puerto de MAMP para Mac
    user: "root",
    password: "root",
    database: "restaurado",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  console.time("⏱️ Tiempo total de inserción masiva (Ocurrencias y Vehículos)");

  // 1. Obtener los IDs de LUGARES válidos desde la base de datos
  const [lugaresRows] = await connection.query("SELECT id_lugar FROM lugar");
  if (lugaresRows.length === 0) {
    throw new Error("🔴 No hay registros en la tabla 'lugar'.");
  }
  const idsLugaresValidos = lugaresRows.map(row => row.id_lugar);
  console.log(`📍 Se encontraron ${idsLugaresValidos.length} lugares válidos.`);

  // 2. Obtener los IDs de USUARIOS válidos desde la base de datos
  const [usuariosRows] = await connection.query("SELECT id_usuario FROM usuarios_sistema");
  if (usuariosRows.length === 0) {
    throw new Error("🔴 No hay usuarios registrados en la tabla 'usuarios_sistema'.");
  }
  const idsUsuariosValidos = usuariosRows.map(row => row.id_usuario);
  console.log(`👤 Se encontraron ${idsUsuariosValidos.length} usuarios válidos.`);

  // 3. Obtener id_modalidadp original desde la base de datos
  const [modalidadesRows] = await connection.query("SELECT DISTINCT id_modalidadp FROM ocurrencia_registro");
  const idsModalidadesP = modalidadesRows.length > 0 
    ? modalidadesRows.map(row => row.id_modalidadp) 
    : ["3"]; 

  // Seleccionar un usuario fijo (intentamos usar el ID 40 si existe, si no, el primer usuario disponible)
  const idUsuarioFijo = idsUsuariosValidos.includes(40) ? 40 : idsUsuariosValidos[0];

  // Configuración solicitada: 3000 registros en total (500 para el usuario fijo, 2500 variados)
  const totalRegistros = 3000;
  const registrosUsuarioFijos = 500;
  const listaTareasUsuarios = [];

  for (let i = 0; i < registrosUsuarioFijos; i++) {
    listaTareasUsuarios.push(idUsuarioFijo);
  }

  for (let i = 0; i < (totalRegistros - registrosUsuarioFijos); i++) {
    const idAleatorio = idsUsuariosValidos[Math.floor(Math.random() * idsUsuariosValidos.length)];
    listaTareasUsuarios.push(idAleatorio);
  }

  // Mezclar el arreglo para combinar los registros de forma equitativa
  listaTareasUsuarios.sort(() => Math.random() - 0.5);

  const tamañoLote = 3000;     
  let contadorGlobalIndice = 0;

  // Fechas y horas actualizadas solicitadas
  const fechaEventoFija = "2026-09-28";
  const horaAlertaFija = "23:54:00";
  const horaLlegadaFija = "23:54:00";
  const horaRepliegueFija = "23:54:00"; 
  const fechaHoraReporteFija = "2026-09-28 23:59:00";

  console.log(`🚀 Iniciando generación masiva total de ${totalRegistros} ocurrencias...`);

  try {
    for (let i = 0; i < listaTareasUsuarios.length; i += tamañoLote) {
      const loteActual = listaTareasUsuarios.slice(i, i + tamañoLote);
      const filasSQLOcurrencia = [];

      console.log(`📦 Procesando lote del ${i + 1} al ${i + loteActual.length}...`);

      for (let j = 0; j < loteActual.length; j++) {
        const idUsuario = loteActual[j];
        contadorGlobalIndice++;
        const indiceLocal = i + j + 1;

        // id_modalidad variando del 1 al 100 de forma aleatoria
        const idModalidadAleatoria = Math.floor(Math.random() * 100) + 1;

        // id_origen variando del 1 al 11 de forma aleatoria
        const idOrigenAleatorio = Math.floor(Math.random() * 11) + 1;

        // id_modalidadp original seleccionado de los existentes
        const idModalidadPAleatoria = idsModalidadesP[Math.floor(Math.random() * idsModalidadesP.length)];

        // Seleccionar aleatoriamente un lugar real de la base de datos
        const idLugarAleatorio = idsLugaresValidos[Math.floor(Math.random() * idsLugaresValidos.length)];

        const valoresFila = [
          connection.escape(`POR LLAMADO DE LA CENTRAL\nUsuario ${idUsuario} - Test ${indiceLocal}`), // 1. descripcion
          connection.escape(horaAlertaFija),                                     // 2. hora_alerta
          connection.escape(horaLlegadaFija),                                    // 3. hora_llegada
          connection.escape(horaRepliegueFija),                                  // 4. hora_repliegue
          connection.escape(idLugarAleatorio),                                   // 5. id_lugar variable y válido
          connection.escape(idUsuario),                                          // 6. id_usuario variable/fijo
          connection.escape(idModalidadAleatoria),                               // 7. id_modalidad variable (1 al 100)
          connection.escape(idOrigenAleatorio),                                  // 8. id_origen variable (1 al 11)
          connection.escape(3),                                                  // 9. id_tipop
          connection.escape(idModalidadPAleatoria),                              // 10. id_modalidadp original
          connection.escape("-12.073769"),                                       // 11. latitud_gps
          connection.escape("-77.039673"),                                       // 12. longitud_gps
          connection.escape(""),                                                 // 13. nombre_punto_gps
          connection.escape(`xcxzc REF ${indiceLocal}`),                         // 14. referencia
          connection.escape("SERENAZGO"),                                        // 15. unidad_encargada
          connection.escape(fechaHoraReporteFija),                               // 16. fecha_reporte fija
          connection.escape(fechaEventoFija),                                    // 17. fecha_evento fija
          connection.escape("PENDIENTE"),                                        // 18. estado
          connection.escape("1"),                                                // 19. grupo
        ];

        filasSQLOcurrencia.push(`(${valoresFila.join(",")})`);
      }

      // 1. Insertar ocurrencias en lote
      const sqlOcurrencias = `
        INSERT INTO ocurrencia_registro (
          descripcion, hora_alerta, hora_llegada, hora_repliegue, 
          id_lugar, id_usuario, id_modalidad, id_origen,
          id_tipop, id_modalidadp, latitud_gps, longitud_gps, 
          nombre_punto_gps, referencia, unidad_encargada, 
          fecha_reporte, fecha_evento, estado, grupo
        ) VALUES ${filasSQLOcurrencia.join(",")}
      `;

      const [resultadoOcurrencia] = await connection.query(sqlOcurrencias);
      const primerInsertId = resultadoOcurrencia.insertId;

      // 2. Generar vehículos enlazados usando el ID autoincrementado correcto
      const filasSQLVehiculos = [];
      for (let j = 0; j < filasSQLOcurrencia.length; j++) {
        const idOcurrenciaActual = primerInsertId + j;
        
        const valoresVehiculo = [
          connection.escape(idOcurrenciaActual), // id_ocurrencia enlazado
          connection.escape(1),                  // id_tipo_vehiculo
          connection.escape(1),                  // id_unidad
          connection.escape("INTEGRADO"),        // tipo_asignacion
          connection.escape(1),                  // id_pnp
        ];

        filasSQLVehiculos.push(`(${valoresVehiculo.join(",")})`);
      }

      const sqlVehiculos = `
        INSERT INTO ocurrencia_vehiculo_detalle (
          id_ocurrencia, id_tipo_vehiculo, id_unidad, tipo_asignacion, id_pnp
        ) VALUES ${filasSQLVehiculos.join(",")}
      `;

      await connection.query(sqlVehiculos);
    }

    console.log("🎉 Carga masiva total completada con éxito.");

    // --- CONSOLIDADO FINAL ---
    console.log("\n📊 --- CONSOLIDADO DE LA CARGA ---");
    const [consolidado] = await connection.query(`
      SELECT 
        id_usuario,
        COUNT(*) AS total_registros,
        COUNT(DISTINCT id_lugar) AS lugares_diferentes,
        COUNT(DISTINCT id_modalidad) AS modalidades_diferentes,
        MIN(fecha_evento) AS fecha_inicio,
        MAX(fecha_evento) AS fecha_fin,
        MIN(fecha_reporte) AS reporte_inicial,
        MAX(fecha_reporte) AS reporte_final
      FROM ocurrencia_registro
      WHERE fecha_evento = '2026-09-28' AND hora_llegada = '23:54:00'
      GROUP BY id_usuario
      ORDER BY total_registros DESC
    `);
    console.table(consolidado);

  } catch (error) {
    console.error("🔴 Error en la inserción masiva:", error.message);
  } finally {
    console.timeEnd("⏱️ Tiempo total de inserción masiva (Ocurrencias y Vehículos)");
    await connection.end();
  }
}

generarOcurrenciasMasivas();