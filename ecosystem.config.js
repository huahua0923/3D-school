// PM2 进程管理配置
// 用法: pm2 start ecosystem.config.js
module.exports = {
    apps: [{
        name: 'exhibition-nav-api',
        script: 'server.js',
        cwd: '/var/www/exhibition-nav',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '200M',
        env: {
            NODE_ENV: 'production',
        },
        error_file: '/var/log/exhibition-nav-error.log',
        out_file: '/var/log/exhibition-nav-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
    }],
};
