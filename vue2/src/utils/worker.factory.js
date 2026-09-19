/**
 * Web Worker 工厂 —— 默认实现（webpack 5 原生语法）
 *
 * webpack 5 会静态识别下面的写法，把 tracker.worker.js 抽成独立 chunk，
 * 无需任何额外 loader：
 *     new Worker(new URL("./tracker.worker.js", import.meta.url))
 *
 * 老版本工程（webpack 3/4）不支持该语法（import.meta 也无法解析），
 * 请把 tracker.js 中的这一行：
 *     import { createTrackWorker } from "./worker.factory";
 * 改为：
 *     import { createTrackWorker } from "./worker.factory.legacy";
 * 并安装对应版本的 worker-loader（webpack4 → @3，webpack3 → @2），其余代码零改动。
 */
export function createTrackWorker() {
  return new Worker(new URL("./tracker.worker.js", import.meta.url));
}
