/**
 * 前端运行配置（部署时只改这个文件）。
 *
 * 前端是纯静态页面，可以和后端分开部署：
 *  - 同源部署：apiBase 留空，题库 bankBase 留空（默认读取同目录下的 ../bank 或 ./bank）。
 *  - 分离部署：把 apiBase 改成后端地址，例如 "https://quiz-api.example.com"。
 *  - 题库托管：bankBase 可以指向任意静态地址（GitHub Pages / jsDelivr / 对象存储），
 *    例如 "https://cdn.jsdelivr.net/gh/happysoysaucemin/quiz-dx-bank@main/"。
 *    题库仓库：https://github.com/happysoysaucemin/quiz-dx-bank
 *    注意必须以 / 结尾，且目录内要有 index.json 和 13006.json 等文件。
 *
 * GitHub Pages 上（*.github.io）没有 Node 服务端，会自动切到纯本地模式：
 * 成绩、错题本、评分都存 localStorage；想强制开关用 ?noserver=1 / ?server=1。
 */
const params = new URLSearchParams(location.search);
const isStaticHost = /\.github\.io$/i.test(location.hostname);

if (params.get('noserver') === '1') params.set('server', '0');
const serverOff = params.get('server') === '0' || (isStaticHost && params.get('server') !== '1');

window.APP_CONFIG = {
  // 后端 API 根地址；留空 = 与页面同源（例如由 server 同时托管 web 与 bank）
  apiBase: '',

  // 题库根地址；留空 = 页面同级的 ./bank/
  bankBase: '',

  // 请求超时（毫秒）
  requestTimeout: 9000,

  // 是否启用服务端（false 则完全本地模式，成绩只存在浏览器里）
  useServer: !serverOff,
};
