module.exports = {
  apps: [
    {
      name: "sipcop-backend",
      script: "./index.js",     // ⚠️ Cambia esto por el nombre real de tu archivo principal (ej. server.js o app.js)
      instances: "max",         // Usa todos los núcleos disponibles de tu CPU en la nube
      exec_mode: "cluster",     // Activa el modo cluster
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};