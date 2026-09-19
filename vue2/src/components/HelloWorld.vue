<template>
  <div class="hello">
    <h1>{{ msg }}</h1>
    <p class="tip">项目已成功跑通：SFC 单文件组件、props 传递、热更新均正常。</p>
  </div>
</template>

<script>
export default {
  name: "HelloWorld",
  props: {
    msg: {
      type: String,
      required: true
    }
  }
};
</script>

<style scoped>
.hello {
  text-align: center;
}

.hello h1 {
  color: #2c3e50;
  margin: 0 0 8px;
}

.tip {
  color: #7f8c9b;
  font-size: 14px;
  margin: 0;
}
</style>
