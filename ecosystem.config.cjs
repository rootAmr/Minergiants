module.exports = {
  apps: [
    {
      name: "absen-tipu-getah",
      script: "server.js",
      interpreter: "node",
      env: {
        PORT: "3022",
        APP_ALLOWED_ORIGINS: "https://absen.yuris.my.id",
        APP_DATA_DIR: "./data",
        HRIS_DEV_MODE: "false",
      },
    },
  ],
};
