// pm2 configuration – keeps the bot running 24/7 with auto-restart
module.exports = {
  apps: [
    {
      name: 'copy-bot',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      // Log files
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
