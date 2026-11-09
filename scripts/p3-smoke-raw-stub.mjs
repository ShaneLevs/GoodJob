/**
 * p3-*-smoke.mjs 共用的 `?raw` 桩。
 *
 * Node 26 + jiti 不认 Vite 的 `?raw` 后缀（`.md` 会被当成 ESM 去解析，直接
 * ERR_UNKNOWN_FILE_EXTENSION）。冒烟只关心 store / 服务逻辑，不读技能正文，
 * 所以在 jiti 的 alias 里把 `./SKILL.md?raw` 这类说明符映射到这个空串模块。
 */
export default "";
