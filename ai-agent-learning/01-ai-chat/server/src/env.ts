import dotenv from "dotenv";

// 必须在所有读取 process.env 的模块之前执行，
// 因此单独抽到一个文件，由 index.ts 最先 import。
dotenv.config();