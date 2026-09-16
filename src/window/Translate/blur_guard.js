// 翻译窗 blur 自动关闭的全局抑制开关
// 静默"翻译并替换原文"期间窗口会主动 hide 以执行后台翻译，
// 此时不能让模块级 blur 监听把窗口（及在途翻译）销毁。
let suppress = false;

export const setBlurSuppress = (v) => {
    suppress = !!v;
};

export const isBlurSuppressed = () => suppress;
