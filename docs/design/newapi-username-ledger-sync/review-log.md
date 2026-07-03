# 评审处理表 — newapi-username-ledger-sync

> 跨轮累积。每条评审 finding 一行，记录分级与处理结论。与 `DESIGN.md` 同目录维护。

## 第 1 轮（NO-GO，已返工）

- Codex verdict：NO-GO / needs-revision
- 总评：第 1 轮设计把长邮箱 fail-closed 写得像完整满足需求，New API username 更新能力验证、邮箱变更事务、后台补偿入口、sqlite 发布范围和 `role` 防护均不够明确，不能进入开发。

| 编号 | 分级 | 类别 | 落点（文件/章节/接口/数据流/测试） | Codex 建议 | 处理（采纳/部分采纳/拒绝） | 理由 / DESIGN.md 改动位置 |
|---|---|---|---|---|---|---|
| F1 | Blocker | 产品完整性 / 上线条件 | `DESIGN.md` 0、1、5、12 | 长邮箱不是边缘场景，未 patch New API 只能自动支持 `<=20` 邮箱；必须改成“两阶段/条件上线”，完整满足 username=email 需 New API 放宽长度并复做 spike。 | 采纳 | 已改为 Phase A 安全基础 + Phase B 完整上线；长邮箱 Phase A 只进入 `username_sync_failed`，不能宣称完整上线。见第 0、1、5、12 节。 |
| F2 | Blocker | 外部依赖验证 | `DESIGN.md` 4、7.3、12 | 设计必须显式记录 New API Update User 验证，含端点、权限、源码路径、镜像版本、请求/响应形态和失败形态。 | 采纳 | 已补官方文档、`/tmp/new-api-source` main commit、`calciumion/new-api:latest` 容器 spike、`v1.0.0-rc.10`、短 username 成功、重复 username 失败、长 username validation 失败和失败后保持旧 username。见第 4、4.1 节。 |
| F3 | Blocker | 数据一致性 / 邮箱变更 | `DESIGN.md` 7.6、8.2、12 | 邮箱变更事务语义必须定稿：普通用户本轮不开放；后台短邮箱远端先成功再提交本地 email；长邮箱默认不提交本地 email，除非明确 admin override。 | 采纳 | 已固定默认语义，并在时序图中写明长邮箱不提交 `user.email`、短邮箱远端确认后本地事务提交。见第 7.6、8.2、12 节。 |
| F4 | Major | 运维闭环 / 管理后台 | `DESIGN.md` 7.9、8.3、10、11 | 管理后台异常、重试和人工处理要落到具体入口、action、DTO 去敏和状态流，不能只说“可观察”。 | 采纳 | 已补用户列表筛选、用户详情展示、`retryNewapiUserBinding`、`confirmNewapiUserConflict`、`disableNewapiUserBinding`、管理员/用户 DTO 去敏和时序图。见第 7.9、8.3、10、11 节。 |
| F5 | Major | schema 发布范围 | `DESIGN.md` 3.2、6、7.2、9、11、12 | 当前仓库实际只导出 sqlite/libsql，迁移目录也只有 sqlite；不要继续承诺 mysql/postgres 同步修改。 | 采纳 | 已收窄为 sqlite/libsql 发布范围，mysql/postgres 明确范围外并需另开 feature。见第 3.2、6、7.2、9、11、12 节。 |
| F6 | Major | 权限安全 | `DESIGN.md` 5、7.3、11 | `updateUserProfile()` 的 `role` 不能由调用方传入，必须先回读远端 role 并原样提交。 | 采纳 | 已移除调用方 role 参数，并要求 client 回读远端 role 后原样提交。见第 5、7.3、11 节。 |

## 第 2 轮（GO with conditions）

- Codex verdict：GO with conditions
- Blocker：无
- Major：无
- 总评：第 2 轮复评认可第 1 轮 Blocker/Major 已处理完毕，设计可冻结并进入计划阶段；条件项需在计划与实现阶段持续跟踪。

### 上一轮 Blocker/Major 解决状态

| 编号 | status（resolved / partially_resolved / unresolved） | evidence（DESIGN.md 哪处改动支撑） |
|---|---|---|
| F1 | resolved | 第 0、1、5、12 节将方案改为 Phase A / Phase B，并把长邮箱完整支持列为 Phase B 条件。 |
| F2 | resolved | 第 4、4.1 节记录官方文档、源码 commit、容器 spike、版本、成功和失败形态。 |
| F3 | resolved | 第 7.6、8.2 节固定邮箱变更远端先成功、本地后提交，长邮箱默认不提交本地 email。 |
| F4 | resolved | 第 7.9、8.3、10、11 节补齐后台筛选、详情、actions、DTO 去敏和验证矩阵。 |
| F5 | resolved | 第 3.2、6、7.2、9、11、12 节明确只支持 sqlite/libsql，mysql/postgres 范围外。 |
| F6 | resolved | 第 5、7.3、11 节要求 role 由远端回读并原样提交。 |

### 本轮仍未解决 / 新增

| 编号 | 分级 | 落点 | Reviewer 建议 | 处理 / 理由 |
|---|---|---|---|---|
| M1 | Minor | `DESIGN.md` 日期 | Reviewer 认为日期应改为 2026-07-02。 | 拒绝 / 不采纳。Reviewer 上下文日期误判；当前用户环境为 2026-07-03，设计和需求日期保持 2026-07-03。 |
| M2 | Minor | 计划阶段后台落点 | 计划阶段点名后台落点文件：`src/app/[locale]/(admin)/admin/users/page.tsx` 与 `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`。 | 采纳并带入计划阶段。本设计阶段不修改 `DESIGN.md`，在后续 PLAN 中明确这两个后台入口。 |

## 终止结论

**三档判定规则**：

- **GO** = 0 Blocker/Major，且无需开发中跟踪的条件项。
- **GO with conditions** = 0 Blocker/Major，但有需开发中跟踪的条件项或 Minor 债务。
- **NO-GO** = 任一未解决 Blocker/Major 或分歧，上交人类。

- **本次结论**：GO with conditions。设计阶段冻结，可进入计划阶段。
- **带入开发的 Minor / 条件项**：
  - Phase A 只交付短邮箱自动同步与安全基础。
  - `>20` 邮箱必须阻断为 `username_sync_failed` / `newapi_username_too_long`，不得生成技术名冒充一致。
  - Phase B 需 New API 自管 / patch 镜像放宽 `Username` / `DisplayName`，并重复 Update User spike。
  - 本轮只支持 sqlite/libsql。
  - 后台 `retry` / `confirm conflict` / `disable` 是 Phase A 必需闭环。
  - 用户 DTO 不暴露 remote id、token、internal group、internal domain、raw SQL validation。
  - 计划阶段需点名后台入口：`src/app/[locale]/(admin)/admin/users/page.tsx` 与 `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`。
- **上交人类的未决项**：Phase B 是否启动 New API 自管 / patch 镜像；是否允许 admin override 造成本地 email 与 New API username 临时不一致。
- 评审轮数：2
- **冻结收尾**：设计阶段冻结；本次按用户要求只更新 `review-log.md`，不修改 `DESIGN.md`。
