命令参数承载与错误分类

所有命令通过统一的 parseCommandArgs(raw) 和命令必填字段表进入业务处理。工具 args 参数声明为 JSON 值，以便命令层自己给出明确形态错误；推荐 JSON 字符串，也接受普通对象。字符串先 trim；空串、undefined、null 作为空对象。对象不再次 JSON.parse，也不修改其字段或 ID。JSON 字符串解码后必须为非数组普通对象。

错误回执：

- missing-argument：返回 command、missing、acceptedShape、acceptedArgsFormats 和 hint。错误使用 arguments 等未知顶层字段时，会逐一提示“未知字段 arguments，已忽略”，不偷偷把它当作 args。
- invalid-argument-json：返回解析器原始 message 和原输入的前 80 字符 received，不进入查库或业务逻辑。
- invalid-arguments-shape：expected 为 object；received 说明 array、number、boolean、null 或其他非法形态。
- not-found：只在正常进入查找后确实不存在时返回 command、原始 id、scanned、idPrefix（前 8 字符）、idLength；保留 message="记录不存在"，不再把它用作缺参错误。

示例：

    {"command":"inspect","args":"{\"taskId\":\"<uuid>\"}"}
    {"command":"inspect","args":{"taskId":"<uuid>"}}

两种形式等价。工具描述和 guide.examples 为每个受支持命令提供一行最小参数形状；复杂票据仍必须满足原有冻结契约。布尔 false 和空数组不会被当成缺参；它们的合法性继续由对应业务约束判断。项目和角色隐式上下文不要求成员自行伪造，UI 的 scopePreview 则明确要求 projectId。

实现不更改 taskId 匹配规则、冻结契约、角色授权或归属校验。缺参和解析错误不会写入操作回执，也不会读取任务表；鉴权 HTTP 调用仍需原令牌。业务中的条件性契约要求继续在原有契约校验中执行。

验证：tests/command-arguments.test.mjs 覆盖成员误用 arguments、真实 inspect 的双形态、原生解析器错误文本与截断、非对象拒绝、不读库、HTTP/worker 回传、命令必填表及示例完整性。独立兼容性探针还使用实际安装的 DSH defineTool 验证 JSON 参数声明。

生效需更新 LingFlow 后端并重载 DSH 插件；只打开连接旧服务的窗口不会加载新代码。
