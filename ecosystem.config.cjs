// ---------------------------------------------------------------
// 可选方案：使用 PM2 管理进程（替代内置 chat-cc start 守护进程）
// 用法：pm2 start ecosystem.config.cjs
// 推荐：优先使用 chat-cc start（内置 daemon），PM2 仅作高级替代
// ---------------------------------------------------------------
module.exports = {
  apps: [
    {
      name: 'chatcc-v3',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        CHAT_CC_DAEMON: '1',
        CHAT_CC_CONFIG: './config.local.yaml',
      },
      error_file: 'logs/chatcc-v3.err.log',
      out_file: 'logs/chatcc-v3.out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 10000,
    },
  ],
};
