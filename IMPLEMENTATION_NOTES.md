# 鼠标位置检测功能实现说明

## 功能概述
实现了鼠标在图表上移动时，实时显示该位置对应的数据点的相对流量数值。

## 实现方案
采用**方案 1：监听 Google Trends 原生 Tooltip**，这是最简单可靠的方案。

## 核心实现

### 1. 数据存储
- `fullTimelineData`: 存储完整的 timelineData 数组
- `keywordsOrder`: 存储关键词顺序（从 URL 中提取）
- `currentHoverData`: 存储当前鼠标位置对应的数据点

### 2. 关键函数

#### `extractDataFromTooltip()`
- 查找 Google Trends 的 tooltip 元素
- 从 tooltip 文本中提取日期
- 在 `fullTimelineData` 中查找匹配的数据点
- 根据 `keywordsOrder` 提取对应的数值
- 更新 `currentHoverData`

#### `scheduleUpdate()`
- 优先级：鼠标悬停数据 > API数据（最后时间点）> DOM解析数据
- 根据 `currentHoverData` 动态更新悬浮窗标题和内容

### 3. 事件监听
- **MutationObserver**: 监听 tooltip 内容变化
- **mousemove**: 鼠标移动时尝试提取 tooltip 数据
- **mouseleave**: 鼠标离开图表区域时清除悬停数据

## 工作流程

1. 页面加载时，从 API 获取完整的 `timelineData` 并保存
2. 鼠标在图表上移动时，Google Trends 显示 tooltip
3. `extractDataFromTooltip()` 检测到 tooltip 变化，提取日期和数值
4. 在 `fullTimelineData` 中查找匹配的数据点
5. 更新 `currentHoverData` 并触发 `scheduleUpdate()`
6. 悬浮窗显示该时间点的数据（标题包含日期）
7. 鼠标离开图表区域时，清除 `currentHoverData`，恢复显示最后时间点

## 日期匹配逻辑

支持多种日期格式：
- 中文格式：`2025年11月16日至22日`、`2025年11月16日`
- 英文格式：`2024-11-20`、`November 16, 2025`

匹配策略：
1. 精确匹配 `formattedTime`
2. 部分匹配（处理日期范围的情况）

## 注意事项

1. **延迟处理**: tooltip 内容更新有延迟，使用 50ms 延迟确保内容完整
2. **关键词顺序**: 必须从 URL 中正确提取关键词顺序，才能正确匹配数值
3. **鼠标离开**: 使用 500ms 延迟清除，避免快速移动时误清除
4. **降级处理**: 如果无法提取 tooltip 数据，自动降级到显示最后时间点

## 测试建议

1. 在图表上移动鼠标，观察悬浮窗是否实时更新
2. 检查悬浮窗标题是否包含正确的日期
3. 检查数值是否正确（与 tooltip 中的数值一致）
4. 鼠标离开图表区域，检查是否恢复显示最后时间点

