const { defineConfig } = require("@vue/cli-service");
const webpack = require("webpack");

module.exports = defineConfig({
  devServer: {
    proxy: "http://localhost:3000",
  },

  pwa: {
    name: "WUD",
    themeColor: "#00355E",
    msTileColor: "#00355E",
    mobileWebAppCapable: "yes",
    manifestOptions: {
      short_name: "WUD",
      background_color: "#00355E",
    },
  },

  configureWebpack: {
    plugins: [
      new webpack.DefinePlugin({
        __VUE_OPTIONS_API__: "true",
        __VUE_PROD_DEVTOOLS__: "false",
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
      }),
    ],
  },
});
