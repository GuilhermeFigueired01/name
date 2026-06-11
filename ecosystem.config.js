module.exports = {
  apps: [
    {
      name: 'phishing-sim',
      script: 'server.js',

      // reinicia automaticamente se crashar
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',

      // variáveis de ambiente — podem ser sobrescritas pelo .env
      env: {
        NODE_ENV: 'production',
        PORT: 3333,
        ADMIN_KEY: 'aintar-admin-2024',
      },

      // logs com timestamp (ficam em %USERPROFILE%\.pm2\logs\ por defeito)
      error_file: './logs/err.log',
      out_file:   './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // reinicia às 03:00 todos os dias (limpa memória acumulada)
      cron_restart: '0 3 * * *',
    },
  ],
};
