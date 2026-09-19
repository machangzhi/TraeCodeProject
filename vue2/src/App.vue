<template>
  <div id="app">
    <HelloWorld :msg="title" />

    <div class="card">
      <h2>响应式演示（Vue {{ vueVersion }}）</h2>
      <button
        data-track-name="demo_counter_button_click"
        :data-track-params="counterTrackParams"
        @click="count++"
      >
        点击次数：{{ count }}
      </button>
      <p v-if="count === 0">还没有点击，试试按钮</p>
      <p v-else>你已经点击了 {{ count }} 次，双倍计数为 {{ doubleCount }}</p>
    </div>

    <div class="card">
      <h2>表单埋点演示（change）</h2>
      <label class="field">
        <span>备注：</span>
        <input
          v-model="remark"
          type="text"
          name="remark"
          placeholder="输入后失焦即触发 change 埋点"
          data-track-name="demo_remark_input_change"
          :data-track-params="inputTrackParams"
        />
      </label>
      <p v-if="remark">当前备注：{{ remark }}</p>
      <p v-else class="muted">埋点默认不上报输入内容，只记录元素信息，避免泄露隐私。</p>
    </div>
  </div>
</template>

<script>
import Vue from "vue";
import HelloWorld from "@/components/HelloWorld.vue";

export default {
  name: "App",
  components: { HelloWorld },
  data() {
    return {
      title: "欢迎使用 Vue 2.7 + Webpack 5",
      count: 0,
      remark: "",
      vueVersion: Vue.version
    };
  },
  computed: {
    doubleCount() {
      return this.count * 2;
    },
    // 埋点附加参数会随每次点击一起上报（data-track-params 需为 JSON 字符串）
    counterTrackParams() {
      return JSON.stringify({ module: "counter", page: "home" });
    },
    inputTrackParams() {
      return JSON.stringify({ module: "form", field: "remark" });
    }
  }
};
</script>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  background: #f5f7fa;
  color: #2c3e50;
}

#app {
  max-width: 720px;
  margin: 0 auto;
  padding: 40px 20px;
}

.card {
  background: #fff;
  border-radius: 10px;
  padding: 24px;
  margin-top: 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
}

.card h2 {
  margin-top: 0;
  font-size: 18px;
}

button {
  background: #42b983;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 10px 20px;
  font-size: 15px;
  cursor: pointer;
}

button:hover {
  background: #36a372;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.field input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid #d8dde6;
  border-radius: 6px;
  font-size: 14px;
}

.field input:focus {
  outline: none;
  border-color: #42b983;
}

.muted {
  color: #97a0af;
  font-size: 13px;
}
</style>
