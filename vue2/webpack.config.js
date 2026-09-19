const path = require("path");
// vue-loader 15 的插件必须解构导入（不能把整个模块当构造函数）
const { VueLoaderPlugin } = require("vue-loader");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
  entry: "./src/main.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].[contenthash:8].js",
    clean: true
  },
  resolve: {
    extensions: [".js", ".vue", ".json"],
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  module: {
    rules: [
      {
        test: /\.vue$/,
        loader: "vue-loader"
      },
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: "babel-loader"
      },
      {
        test: /\.css$/,
        // style-loader 3 + css-loader 6 均为官方维护，与 webpack 5 原生 ESM 互操作
        use: ["style-loader", "css-loader"]
      }
    ]
  },
  plugins: [
    new VueLoaderPlugin(),
    new HtmlWebpackPlugin({
      template: "./public/index.html",
      title: "Vue2 Webpack App"
    })
  ],
  devServer: {
    port: 8080,
    hot: true,
    open: false,
    historyApiFallback: true
  },
  devtool: "source-map",
  performance: {
    hints: false
  }
};
