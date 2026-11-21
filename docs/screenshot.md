# 站点截图

README 顶部提到 `docs/screenshot.png`，但**仓库里还没有这个文件**（不想提交一张没维护的图）。

想补的话：

```bash
# 1) 先把服务跑起来
npm start                      # 或 bin/start.sh

# 2) 用浏览器打开 http://localhost:5188 ，截一张完整首页
#    macOS：Shift+Cmd+4 选区域，或 Shift+Cmd+5 截整个窗口

# 3) 存成这个路径（宽 1440 左右、PNG 就行）
cp ~/Desktop/截图.png docs/screenshot.png

# 4) README 里把顶部那行说明换成图片
#    ![站点截图](docs/screenshot.png)
```

建议截「首页首屏」：左侧大类导航 + 三张图（c1 份额全景、c2 长期变化率、c3 近 7 日变化率）+ 底部规模表。

注意：图里别带上写着 token 的窗口标题，也别截到浏览器书签栏。
