#!/bin/sh
# 一键部署 exhibition-nav —— 拉取 GitHub main 最新提交并重启 pm2
# 用法：
#   bash deploy.sh            # 拉最新（自动取 main 最新 sha，无缓存延迟）
#   bash deploy.sh <sha>      # 指定某次提交
set -e

REPO=huahua0923/3D-school
APP_DIR=/opt/exhibition-nav
PM2_NAME=exhibition-nav-api

if [ -n "$1" ]; then
  SHA="$1"
else
  # 用 node 解析 API（服务器必有 node），取 main 分支最新 commit sha
  SHA=$(curl -s "https://api.github.com/repos/$REPO/commits/main" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d)[0].sha)}catch(e){console.log('')}})")
fi

if [ -z "$SHA" ]; then
  echo "❌ 取不到 commit sha，检查网络或 API"
  exit 1
fi

echo "🚀 部署 $SHA ..."
curl -L "https://api.github.com/repos/$REPO/tarball/$SHA" -o /tmp/x.tar.gz
tar -xzf /tmp/x.tar.gz -C "$APP_DIR" --strip-components=1
pm2 restart "$PM2_NAME"
echo "✅ 已部署 $SHA"
