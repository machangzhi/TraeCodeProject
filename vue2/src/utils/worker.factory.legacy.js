/**
 * Web Worker 工厂 —— 老版本 webpack（3.x / 4.x）实现
 *
 * 依赖 worker-loader（内联写法，无需修改 webpack.config.js）：
 *   webpack 4：npm install -D worker-loader@3   （@3 同时兼容 webpack 5）
 *   webpack 3：npm install -D worker-loader@2
 *
 * worker-loader 会把 tracker.worker.js 当作独立入口打包（其内部 import
 * 的 sender-core 等依赖照常被编译），默认导出就是 Worker 构造器。
 *
 * 启用方式：把 tracker.js 里
 *     import { createTrackWorker } from "./worker.factory";
 * 改为
 *     import { createTrackWorker } from "./worker.factory.legacy";
 */
import TrackerWorker from "worker-loader!./tracker.worker.js";

export function createTrackWorker() {
  return new TrackerWorker();
}
