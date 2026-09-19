import Vue from "vue";
import App from "./App.vue";
import tracker from "@/utils/tracker";
import { trackerConfig } from "@/tracker.config";

Vue.config.productionTip = false;

// 初始化埋点：绑定全局 click/change 委托，并自动上报一次 PV
tracker.init(trackerConfig);

new Vue({
  render: (h) => h(App)
}).$mount("#app");
