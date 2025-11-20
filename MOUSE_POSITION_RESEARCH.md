# 鼠标位置检测调研报告

## 需求
检测鼠标在图表上的位置，实时显示该位置对应的数据点的相对流量数值。

## 可行性分析

### 方案 1：监听 Google Trends 原生 Tooltip（推荐 ⭐⭐⭐⭐⭐）

**原理：**
- Google Trends 本身会在鼠标移动时显示 tooltip，显示当前数据点的信息
- 我们可以监听这个 tooltip 的内容变化，从中提取数据点的值

**优点：**
- ✅ 最简单可靠，不需要计算坐标
- ✅ Google Trends 已经处理了所有边界情况
- ✅ 可以获取到准确的日期和数值
- ✅ 不依赖图表的具体实现（SVG/Canvas）

**缺点：**
- ⚠️ 需要找到 tooltip 的 DOM 元素
- ⚠️ 需要解析 tooltip 的内容格式

**实现步骤：**
1. 使用 MutationObserver 监听 tooltip 元素的内容变化
2. 从 tooltip 中提取日期和数值
3. 根据日期在 timelineData 中找到对应的数据点
4. 更新悬浮窗显示

**可行性：** ✅ 高度可行

---

### 方案 2：监听图表区域的鼠标事件 + 坐标计算（中等 ⭐⭐⭐）

**原理：**
- 在图表容器上监听 `mousemove` 事件
- 根据鼠标的 X 坐标，计算对应的时间点索引
- 从 timelineData 中获取该时间点的值

**优点：**
- ✅ 响应速度快
- ✅ 不依赖 tooltip 的存在

**缺点：**
- ⚠️ 需要准确获取图表的边界和宽度
- ⚠️ 需要知道时间轴的范围和分辨率
- ⚠️ 不同分辨率（DAY/WEEK/MONTH）需要不同的计算逻辑
- ⚠️ 图表可能使用 SVG 或 Canvas，需要不同的处理方式

**实现步骤：**
1. 找到图表容器元素
2. 监听 `mousemove` 事件
3. 计算鼠标 X 坐标相对于图表左边缘的百分比
4. 根据百分比和时间范围，计算对应的时间点索引
5. 从 timelineData 中获取该时间点的值

**可行性：** ⚠️ 中等可行，但需要处理多种边界情况

---

### 方案 3：从 API 响应中获取完整 timelineData（推荐 ⭐⭐⭐⭐）

**原理：**
- 我们已经从 API 获取了完整的 timelineData
- 当鼠标移动时，根据 tooltip 显示的日期，在 timelineData 中查找对应的数据点

**优点：**
- ✅ 数据准确，来自 API
- ✅ 可以获取所有时间点的数据
- ✅ 不依赖坐标计算

**缺点：**
- ⚠️ 需要将 tooltip 中的日期格式转换为 timelineData 中的时间戳格式
- ⚠️ 需要处理日期格式的差异（中文/英文）

**实现步骤：**
1. 监听 tooltip 内容变化，提取日期字符串
2. 将日期字符串转换为时间戳或匹配 timelineData 中的 formattedTime
3. 在 timelineData 中找到对应的数据点
4. 提取该数据点的 formattedValue 数组
5. 更新悬浮窗显示

**可行性：** ✅ 高度可行

---

## 推荐方案

**最佳方案：方案 1 + 方案 3 结合**

1. **监听 tooltip 内容变化**（方案 1）
2. **从 tooltip 中提取日期和数值**（方案 1）
3. **如果 tooltip 中没有数值，则从 timelineData 中查找**（方案 3）

这样既简单又可靠，不依赖复杂的坐标计算。

---

## 技术实现要点

### 1. 找到 Tooltip 元素
```javascript
// 可能的选择器
const tooltipSelectors = [
  '[role="tooltip"]',
  '[class*="tooltip"]',
  '[class*="hover"]',
  'div[style*="position: absolute"]' // 高 z-index 的绝对定位元素
];
```

### 2. 解析 Tooltip 内容
```javascript
// 可能的格式：
// "2025年11月16日至22日"
// "GPTs: 55"
// "Casual Games: 44"
```

### 3. 匹配 timelineData
```javascript
// timelineData 中的格式：
// formattedTime: "2025年11月16日至22日"
// formattedValue: ["55", "44"]
```

---

## 下一步行动

1. ✅ 调研完成
2. ⏳ 测试方案 1：监听 tooltip 内容变化
3. ⏳ 实现日期匹配逻辑
4. ⏳ 更新悬浮窗显示逻辑

