#!/bin/bash
#
# 每日备份 .local-data（2026-10-13 建，crontab 调用）。
#
# ## 为什么必须做这个
#
# .local-data/ 里躺着的是**钱相关的数据**：user-store.json（账号）、
# membership-store.json（谁买了多久会员、每笔订单）。服务器只有一块盘，
# 程序写坏文件、误删、盘故障，任何一个发生，"谁付过钱、会员到几号"就全没了，
# 只能靠微信商户平台的流水逐笔对账赔付。
#
# ## 设计取舍
#
# 1. **tar 整目录快照**，不是逐文件复制。JSON 存储的写入约定是
#    tmp + rename 原子替换（见各 store 的 serializedMutation），
#    所以任一瞬间目录里的每个文件都是完整版本，快照不存在"半个文件"。
#    attachment-store/（用户上传的 Notice 原文）一并打包——
#    恢复时整目录解开即回到当天状态，不用拼装。
# 2. **打包后立刻 tar -tzf 验完整性**：备份最大的风险不是没跑，
#    而是跑出了一个坏包、30 天后要用的时候才发现打不开。验不过就删掉坏包
#    并以非零码退出（crontab 日志里一眼能看到）。
# 3. **保留 30 天**（find -mtime 删更旧的）。
# 4. 备份目录 chmod 700：包里有用户邮箱、密码哈希和 Notice 原文，
#    和 .env.local 一个敏感级别，不给同机其他账户读的机会。
# 5. **本机备份只防误删/程序写坏，防不了硬盘报废**——盘坏了数据和备份一起没。
#    要防盘坏得把包传出这台机器（Mac 定期 scp 拉走一份，或以后接 COS 上传）。
#    这一步先不做，见 README 备份章节的说明。
#
# 用环境变量覆盖路径/保留期是为了本地测试（BACKUP_APP_DIR/BACKUP_DIR/KEEP_DAYS），
# 服务器上 crontab 裸跑用默认值。

set -euo pipefail
# 备份中包含账号、会话和附件事实。即使目录权限被后续脚本错误放宽，新建的备份
# 文件也必须默认仅当前运行账号可读写。
umask 077

APP_DIR="${BACKUP_APP_DIR:-/home/ubuntu/site}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [ ! -d "$APP_DIR/.local-data" ]; then
  echo "[$(date '+%F %T')] ✗ 找不到 $APP_DIR/.local-data——路径对吗？退出，不产出空备份。"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/local-data-$STAMP.tar.gz"

tar -czf "$TARGET" -C "$APP_DIR" .local-data

# 完整性验证：列不出文件清单＝坏包，删掉并以非零码退出。
if ! tar -tzf "$TARGET" > /dev/null 2>&1; then
  echo "[$(date '+%F %T')] ✗ 备份包损坏，已删除：$TARGET"
  rm -f "$TARGET"
  exit 1
fi

FILE_COUNT="$(tar -tzf "$TARGET" | wc -l | tr -d ' ')"
SIZE="$(du -h "$TARGET" | cut -f1)"
echo "[$(date '+%F %T')] ✓ ${TARGET}（${FILE_COUNT} 个条目，${SIZE}）"

# 保留策略：删掉超过 KEEP_DAYS 天的备份。
find "$BACKUP_DIR" -name 'local-data-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
REMAIN="$(ls -1 "$BACKUP_DIR" | grep -c '^local-data-.*\.tar\.gz$' || true)"
echo "[$(date '+%F %T')] 当前保留 $REMAIN 份（超过 ${KEEP_DAYS} 天的已清理）"

# 体积哨兵：备份目录超过 2GB 提示（知识库会慢慢长大）。
# 只是提醒不动手删——备份宁可多占点盘，也不该被脚本自作主张地清掉。
USED_MB="$(du -sm "$BACKUP_DIR" | cut -f1)"
if [ "$USED_MB" -gt 2048 ]; then
  echo "[$(date '+%F %T')] ⚠ 备份目录已达 ${USED_MB}MB（>2GB），考虑缩短保留期或传到 COS。"
fi
