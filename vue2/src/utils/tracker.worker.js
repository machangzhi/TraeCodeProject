/**
 * 埋点上报 Web Worker
 * 主线程只负责采集并 postMessage，所有网络请求都在本线程完成，避免高频埋点阻塞页面。
 *
 * 协议：
 *   主线程 -> Worker : { type: "init",  config: {...} }
 *                      { type: "track", payload: {...} }
 *                      { type: "flush" }
 *   Worker  -> 主线程 : { type: "result", result: { ok, count, reason } }
 */
import { createSender } from "./sender-core";

var sender = null;

self.onmessage = function (e) {
  var msg = e.data || {};

  if (msg.type === "init") {
    sender = createSender(
      Object.assign({}, msg.config, {
        onResult: function (result) {
          self.postMessage({ type: "result", result: result });
        }
      })
    );
    return;
  }

  if (!sender) return;

  if (msg.type === "track") {
    sender.push(msg.payload);
  } else if (msg.type === "flush") {
    sender.flush();
  }
};
