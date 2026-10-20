# .agents/ — 项目内置的 Agent 知识库

存放官方提供的 Agent Skills（`.agents/skills/` 是 Agent Skills 规范目录，pi 会自动发现并
按需加载；不需要放进 `package.json` 依赖）。这里的技能是**本项目的组件事实来源**，
与 `AGENTS.md` 的硬约束配套使用。

## 已安装

| Skill | 来源 | 版本 | 用途 |
| --- | --- | --- | --- |
| `skills/antd` | [ant-design/ant-design-cli](https://github.com/ant-design/ant-design-cli) → `skills/antd/SKILL.md` | 跟随 CLI 6.6.7 | antd 组件 API / Token / Demo / 迁移查询规范 |
| `skills/x-components` | [`@ant-design/x-skill`](https://www.npmjs.com/package/@ant-design/x-skill) `skills-zh/` | 2.9.0 | `@ant-design/x` UI 组件（Bubble/Sender/Conversations/ThoughtChain…） |
| `skills/use-x-chat` | 同上 | 2.9.0 | `useXChat` Hook、消息管理、多会话 |
| `skills/x-chat-provider` | 同上 | 2.9.0 | Chat Provider（OpenAI / 自定义）接入 |
| `skills/x-request` | 同上 | 2.9.0 | `XRequest` 流式请求与中断 |
| `skills/x-markdown` | 同上 | 2.9.0 | 流式 Markdown 渲染与扩展 |
| `skills/x-card` | 同上 | 2.9.0 | 卡片式组件与数据绑定 |

`x-*` 技能树取自官方中文版（`skills-zh`），与项目语言一致；内容与英文版等价。

## 配套 CLI：`antd`（离线元数据）

```bash
which antd || npm install -g @ant-design/cli   # 已装在 ~/.npm-global/bin/antd
antd -V                                        # 6.6.7
```

查询时**必须带项目版本**，避免拿到其他大版本的 API：

```bash
antd info Tag --version 6.6.6 --lang zh        # props / 默认值 / since / 弃用标记
antd demo Select basic --version 6.6.6         # 可运行示例
antd token Button --version 6.6.6              # 组件级 Design Token
antd semantic Modal --version 6.6.6            # classNames / styles 结构
antd lint ./src --format text                  # 已弃用 API + a11y + 性能
antd usage ./src --format text                 # 项目组件使用统计
```

## 更新

```bash
# antd skill + CLI
npm_config_userconfig=/dev/null npm install -g @ant-design/cli --prefix "$HOME/.npm-global"
git clone --depth 1 https://github.com/ant-design/ant-design-cli /tmp/antd-cli
cp -R /tmp/antd-cli/skills/antd .agents/skills/antd

# X skills（版本需与 package.json 的 @ant-design/x 对齐）
cd /tmp && npm_config_userconfig=/dev/null npm pack @ant-design/x-skill
tar xzf ant-design-x-skill-*.tgz && cp -R package/skills-zh/* "$OLDPWD/.agents/skills/"
```

> 注：本机 `~/.npmrc` 里写着 `proxy=http://127.0.0.1:7897`，代理未启动时 npm/npx 会
> `ECONNRESET`。上面的 `npm_config_userconfig=/dev/null` 就是用来临时绕过该配置的
> （代理可用时去掉即可）。

## 使用约定

1. 写 antd / X 组件前先查（`antd info` 或对应 SKILL.md），不靠记忆；训练数据覆盖的是
   antd 4/5 与 X 1.x，本项目跑的是 antd 6 + X 2，API 有破坏性变更。
2. 改完 antd 代码跑 `antd lint`，弃用 API 一律清零（例如 `Tag bordered` → `variant`）。
3. 只能组合 antd 6 + `@ant-design/x` 2 的组件，不引第二套组件库（见 `AGENTS.md`）。
