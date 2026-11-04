const mysql = require("mysql2/promise");

async function generarOcurrenciasMasivas() {
  const connection = await mysql.createConnection({
    host: "localhost",
    port: 8889, // Puerto de MAMP para Mac
    user: "root",
    password: "root",
    database: "restaurado1",
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

  // Configuración solicitada: 157,000 registros en total distribuidos entre varios usuarios
  const totalRegistros = 157000;
  const registrosUsuarioFijos = Math.floor(totalRegistros * 0.16); 
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

  // Definición de turnos para distribuir la hora de llegada
  const rangosTurnos = [
    { turno: 'M', inicioHora: 7, finHora: 14 },
    { turno: 'T', inicioHora: 15, finHora: 22 },
    { turno: 'N', inicioHora: 23, finHora: 6 }
  ];

  console.log(`🚀 Iniciando generación masiva total de ${totalRegistros} ocurrencias para NOVIEMBRE 2026...`);

  // Fecha base inicial para el incremento secuencial de segundos en fecha_reporte
  let timestampBaseReporte = new Date("2026-11-01T00:00:00").getTime();

  try {
    for (let i = 0; i < listaTareasUsuarios.length; i += tamañoLote) {
      const loteActual = listaTareasUsuarios.slice(i, i + tamañoLote);
      const filasSQLOcurrencia = [];

      console.log(`📦 Procesando lote del ${i + 1} al ${i + loteActual.length} (${((i / totalRegistros) * 100).toFixed(1)}%)...`);

      for (let j = 0; j < loteActual.length; j++) {
        const idUsuario = loteActual[j];
        contadorGlobalIndice++;
        const indiceLocal = i + j + 1;

        // 1. Generar día aleatorio de Noviembre (1 al 30)
        const diaAleatorio = Math.floor(Math.random() * 30) + 1;
        const diaStr = String(diaAleatorio).padStart(2, '0');
        const fechaEventoFija = `2026-11-${diaStr}`;

        // 2. Distribuir aleatoriamente en uno de los 3 turnos
        const turnoSeleccionado = rangosTurnos[Math.floor(Math.random() * rangosTurnos.length)];
        
        let horaAleatoriaNum, minutoAleatorio, segundoAleatorio;
        if (turnoSeleccionado.turno === 'N' && Math.random() > 0.5) {
          horaAleatoriaNum = Math.floor(Math.random() * 7); 
        } else if (turnoSeleccionado.turno === 'N') {
          horaAleatoriaNum = 23;
        } else {
          horaAleatoriaNum = Math.floor(Math.random() * (turnoSeleccionado.finHora - turnoSeleccionado.inicioHora + 1)) + turnoSeleccionado.inicioHora;
        }

        minutoAleatorio = Math.floor(Math.random() * 60);
        segundoAleatorio = Math.floor(Math.random() * 60);

        const horaLlegadaFija = `${String(horaAleatoriaNum).padStart(2, '0')}:${String(minutoAleatorio).padStart(2, '0')}:${String(segundoAleatorio).padStart(2, '0')}`;
        const horaAlertaFija = horaLlegadaFija;
        const horaRepliegueFija = horaLlegadaFija;

        // 3. Incrementar 1 segundo para la fecha_reporte de forma secuencial
        timestampBaseReporte += 1000; 
        const fechaReporteObj = new Date(timestampBaseReporte);
        const fechaHoraReporteFija = fechaReporteObj.toISOString().slice(0, 19).replace('T', ' ');

        // id_modalidad variando del 1 al 100 de forma aleatoria
        const idModalidadAleatoria = Math.floor(Math.random() * 100) + 1;

        // id_origen variando del 1 al 11 de forma aleatoria (garantizado aleatorio)
        const idOrigenAleatorio = Math.floor(Math.random() * 11) + 1;

        // id_modalidadp original seleccionado de los existentes
        const idModalidadPAleatoria = idsModalidadesP[Math.floor(Math.random() * idsModalidadesP.length)];

        // Seleccionar aleatoriamente un lugar real de la base de datos
        const idLugarAleatorio = idsLugaresValidos[Math.floor(Math.random() * idsLugaresValidos.length)];

        const valoresFila = [
          connection.escape(`POR LLAMADO DE LA CENTRAL\nUsuario ${idUsuario} Noviembre Test ${indiceLocal}`), 
          connection.escape(horaAlertaFija),                                     
          connection.escape(horaLlegadaFija),                                    
          connection.escape(horaRepliegueFija),                                  
          connection.escape(idLugarAleatorio),                                   
          connection.escape(idUsuario),                                          
          connection.escape(idModalidadAleatoria),                               
          connection.escape(idOrigenAleatorio),                                  // Origen aleatorio (1-11)
          connection.escape(3),                                                  
          connection.escape(idModalidadPAleatoria),                              
          connection.escape("-12.073769"),                                       
          connection.escape("-77.039673"),                                       
          connection.escape(""),                                                 
          connection.escape(`REF NOV ${indiceLocal}`),                           
          connection.escape("SERENAZGO"),                                        
          connection.escape(fechaHoraReporteFija),                               
          connection.escape(fechaEventoFija),                                    
          connection.escape("PENDIENTE"),                                        
          connection.escape("1"),                                                
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

      // 2. Generar vehículos enlazados
      const filasSQLVehiculos = [];
      for (let j = 0; j < filasSQLOcurrencia.length; j++) {
        const idOcurrenciaActual = primerInsertId + j;
        
        const valoresVehiculo = [
          connection.escape(idOcurrenciaActual), 
          connection.escape(1),                  
          connection.escape(1),                  
          connection.escape("INTEGRADO"),        
          connection.escape(1),                  
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

    console.log("🎉 Carga masiva de 157k registros en Noviembre con orígenes aleatorios completada con éxito.");

  } catch (error) {
    console.error("🔴 Error en la inserción masiva:", error.message);
  } finally {
    console.timeEnd("⏱️ Tiempo total de inserción masiva (Ocurrencias y Vehículos)");
    await connection.end();
  }
}

generarOcurrenciasMasivas();