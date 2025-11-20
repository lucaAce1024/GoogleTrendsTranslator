// content.js
(function() {
  'use strict';

  // 1) 参照词的已知搜索量
  const REFERENCE_TERMS = {
    'gpts': { daily: 2500, name: 'GPTs' },
    'casual games': { daily: 1250, name: 'Casual Games' }
  };
  
  // 默认校准系数（如果没有找到参照词时使用）
  let CAL_FACTOR = 1250 / 63; // ≈ 19.8412698

  // 2) 颜色映射（动态从页面读取，如果无法读取则使用默认值）
  const DEFAULT_COLORS = {
    "casual games": "#4285F4",
    "that's my seat": "#34A853",
    "rooftop and alleys": "#EA4335",
    "ai podcast generator": "#FBBC05",
    "guess the kitty": "#A142F4"
  };

  let termColors = { ...DEFAULT_COLORS };

  // 存储从API获取的数据
  let apiData = {};
  
  // 存储完整的 timelineData（用于根据日期查找数据点）
  let fullTimelineData = [];
  
  // 存储关键词顺序（从 URL 中提取，用于匹配 timelineData 的值）
  let keywordsOrder = [];
  
  // 存储当前鼠标位置对应的数据点（从 tooltip 中提取）
  let currentHoverData = null;
  
  // 存储待处理的响应（在parseApiResponse定义前拦截到的请求）
  let pendingResponses = [];
  
  // 立即设置网络请求拦截器（在页面加载前就设置，确保能拦截到所有请求）
  (function setupInterceptorsEarly() {
    console.log('[扩展] 立即设置网络请求拦截器...');
    
    // 拦截 fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = args[0];
      const urlString = typeof url === 'string' ? url : (url && url.url ? url.url : '');
      
      if (urlString && urlString.includes('/trends/api/widgetdata/multiline')) {
        console.log('[扩展] 拦截到 fetch multiline 请求:', urlString.substring(0, 200));
        const fetchPromise = originalFetch.apply(this, args);
        
        // 异步处理响应，不阻塞原始请求
        fetchPromise.then(response => {
          if (!response.ok) {
            console.warn('[扩展] fetch 响应状态码:', response.status);
            return;
          }
          
          // 克隆响应以便读取
          const clonedResponse = response.clone();
          clonedResponse.text().then(text => {
            try {
              console.log('[扩展] ========== 拦截到 fetch multiline 响应 ==========');
              console.log('[扩展] URL:', urlString.substring(0, 300));
              console.log('[扩展] 响应长度:', text.length);
              console.log('[扩展] 响应前500字符:', text.substring(0, 500));
              // 如果parseApiResponse已定义，直接调用；否则保存待处理
              if (typeof parseApiResponse === 'function') {
                parseApiResponse(text, urlString);
              } else {
                console.log('[扩展] parseApiResponse未定义，保存待处理');
                pendingResponses.push({ text, url: urlString });
              }
            } catch (e) {
              console.warn('[扩展] 解析 fetch API响应失败:', e, e.stack);
            }
          }).catch(e => {
            console.warn('[扩展] 读取 fetch 响应文本失败:', e);
          });
        }).catch(e => {
          console.warn('[扩展] fetch 请求失败:', e);
        });
        
        return fetchPromise;
      }
      return originalFetch.apply(this, args);
    };

    // 拦截 XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._url = url;
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      if (this._url && this._url.includes('/trends/api/widgetdata/multiline')) {
        console.log('[扩展] 拦截到 XHR multiline 请求:', this._url.substring(0, 200));
        const xhr = this;
        
        // 监听 load 事件
        xhr.addEventListener('load', function() {
          try {
            if (xhr.readyState === 4 && xhr.status === 200) {
              if (xhr.responseText) {
                console.log('[扩展] ========== 拦截到 XHR multiline 响应 ==========');
                console.log('[扩展] URL:', xhr._url.substring(0, 300));
                console.log('[扩展] 响应长度:', xhr.responseText.length);
                console.log('[扩展] 响应前500字符:', xhr.responseText.substring(0, 500));
                // 如果parseApiResponse已定义，直接调用；否则保存待处理
                if (typeof parseApiResponse === 'function') {
                  parseApiResponse(xhr.responseText, xhr._url);
                } else {
                  console.log('[扩展] parseApiResponse未定义，保存待处理');
                  pendingResponses.push({ text: xhr.responseText, url: xhr._url });
                }
              } else {
                console.warn('[扩展] XHR 响应文本为空');
              }
            } else {
              console.warn('[扩展] XHR 状态异常，readyState:', xhr.readyState, 'status:', xhr.status);
            }
          } catch (e) {
            console.warn('[扩展] 解析 XHR API响应失败:', e, e.stack);
          }
        });
        
        xhr.addEventListener('error', function() {
          console.warn('[扩展] XHR 请求失败');
        });
      }
      return originalSend.apply(this, args);
    };
    
    console.log('[扩展] 网络请求拦截器设置完成（早期设置）');
  })();

  // 拦截网络请求，获取Google Trends API数据
  function interceptNetworkRequests() {
    console.log('设置网络请求拦截器...');
    
    // 拦截 fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = args[0];
      if (typeof url === 'string' && url.includes('/trends/api/widgetdata/')) {
        console.log('拦截到 fetch 请求:', url.substring(0, 200));
        return originalFetch.apply(this, args).then(response => {
          // 克隆响应以便读取
          const clonedResponse = response.clone();
          clonedResponse.text().then(text => {
            try {
              console.log('开始解析 fetch 响应，URL:', url.substring(0, 200));
              parseApiResponse(text, url);
            } catch (e) {
              console.warn('解析 fetch API响应失败:', e);
            }
          }).catch(e => {
            console.warn('读取 fetch 响应文本失败:', e);
          });
          return response;
        }).catch(e => {
          console.warn('fetch 请求失败:', e);
          return originalFetch.apply(this, args);
        });
      }
      return originalFetch.apply(this, args);
    };

    // 拦截 XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._url = url;
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      if (this._url && this._url.includes('/trends/api/widgetdata/')) {
        console.log('拦截到 XHR 请求:', this._url.substring(0, 200));
        this.addEventListener('load', function() {
          try {
            if (this.responseText) {
              console.log('开始解析 XHR 响应，URL:', this._url.substring(0, 200));
              parseApiResponse(this.responseText, this._url);
            } else {
              console.warn('XHR 响应文本为空');
            }
          } catch (e) {
            console.warn('解析 XHR API响应失败:', e);
          }
        });
        this.addEventListener('error', function() {
          console.warn('XHR 请求失败');
        });
      }
      return originalSend.apply(this, args);
    };
    
    console.log('网络请求拦截器设置完成');
  }

  // 从URL中解析搜索词
  function parseKeywordsFromUrl(url) {
    try {
      console.log('开始解析URL中的关键词，URL:', url.substring(0, 200));
      const urlObj = new URL(url);
      const reqParam = urlObj.searchParams.get('req');
      if (!reqParam) {
        console.warn('URL中没有req参数');
        return [];
      }
      
      // req参数是URL编码的JSON，需要解码
      const decodedReq = decodeURIComponent(reqParam);
      console.log('解码后的req参数（前500字符）:', decodedReq.substring(0, 500));
      const reqData = JSON.parse(decodedReq);
      
      // 从comparisonItem中提取搜索词
      const keywords = [];
      if (reqData.comparisonItem && Array.isArray(reqData.comparisonItem)) {
        console.log('找到 comparisonItem，数量:', reqData.comparisonItem.length);
        reqData.comparisonItem.forEach((item, idx) => {
          if (item.complexKeywordsRestriction && 
              item.complexKeywordsRestriction.keyword && 
              Array.isArray(item.complexKeywordsRestriction.keyword)) {
            item.complexKeywordsRestriction.keyword.forEach(kw => {
              if (kw.value) {
                keywords.push(kw.value);
                console.log(`提取关键词[${idx}]:`, kw.value);
              }
            });
          } else {
            console.warn(`comparisonItem[${idx}] 没有有效的 keyword 结构`);
          }
        });
      } else {
        console.warn('reqData中没有comparisonItem或不是数组');
      }
      
      console.log('最终提取的关键词:', keywords);
      return keywords;
    } catch (e) {
      console.warn('从URL解析搜索词失败:', e, e.stack);
      return [];
    }
  }

  // 解析API响应数据
  function parseApiResponse(text, url) {
    try {
      // 只处理multiline类型的请求
      if (!url.includes('/widgetdata/multiline')) {
        return;
      }
      
      // Google Trends API 返回的数据格式通常是: )]}'\n{...json...} 或 )]}',\n{...json...}
      // 需要移除前缀
      let jsonText = text.trim();
      
      // 移除 )]}' 前缀
      if (jsonText.startsWith(")]}'")) {
        jsonText = jsonText.substring(4).trim();
      }
      
      // 移除可能存在的逗号和换行符
      if (jsonText.startsWith(",")) {
        jsonText = jsonText.substring(1).trim();
      }
      if (jsonText.startsWith("\n")) {
        jsonText = jsonText.substring(1).trim();
      }
      
      // 再次检查并移除逗号（处理 )]}', 的情况）
      if (jsonText.startsWith(",")) {
        jsonText = jsonText.substring(1).trim();
      }

      console.log('[扩展] 清理后的JSON前200字符:', jsonText.substring(0, 200));
      const data = JSON.parse(jsonText);
      
      // 解析 multiline 数据
      if (data.default) {
        const timelineData = data.default.timelineData || [];
        
        if (timelineData.length === 0) {
          console.warn('timelineData为空');
          return;
        }
        
        // 从URL中获取搜索词
        const keywords = parseKeywordsFromUrl(url);
        
        if (keywords.length === 0) {
          console.warn('无法从URL中解析搜索词，URL:', url.substring(0, 200));
          return;
        }
        
        // 保存关键词顺序（用于后续匹配）
        keywordsOrder = keywords.map(k => k.toLowerCase().trim());
        console.log('[扩展] 保存关键词顺序:', keywordsOrder);
        
        // 获取timelineData中最后一个时间点（按时间戳排序后的最后一个）
        // 按时间戳排序，确保获取最新的数据点
        let sortedTimeline = [...timelineData];
        sortedTimeline.sort((a, b) => {
          const timeA = parseInt(a.time) || 0;
          const timeB = parseInt(b.time) || 0;
          return timeA - timeB; // 按时间戳升序排序
        });
        
        // 直接使用最后一个时间点
        const lastDataPoint = sortedTimeline[sortedTimeline.length - 1];
        
        if (!lastDataPoint) {
          console.warn('无法获取最后一组数据，timelineData长度:', timelineData.length);
          return;
        }
        
        // 优先使用 formattedValue，如果没有则使用 value
        const valueArray = lastDataPoint.formattedValue || lastDataPoint.value;
        if (!valueArray || !Array.isArray(valueArray)) {
          console.warn('最后一个数据点没有有效的 value 或 formattedValue 数组');
          return;
        }
        
        // 调试：输出关键信息
        console.log('========== [扩展] 开始解析 API 响应 ==========');
        console.log('[扩展] timelineData总长度:', timelineData.length);
        console.log('[扩展] 从URL解析的关键词（按顺序）:', keywords);
        
        // 打印最后3个数据点的详细信息
        console.log('[扩展] 最后3个数据点详情:');
        const last3Points = sortedTimeline.slice(-3);
        last3Points.forEach((point, idx) => {
          const actualIdx = sortedTimeline.length - 3 + idx;
          console.log(`  [${actualIdx}] 时间: ${point.time} (${point.formattedTime})`);
          console.log(`    formattedValue:`, point.formattedValue);
          console.log(`    value:`, point.value);
        });
        
        console.log('[扩展] 最后一个时间点（将使用此数据）:');
        console.log('  时间:', lastDataPoint.time, lastDataPoint.formattedTime);
        console.log('  formattedValue数组:', valueArray);
        console.log('  value数组:', lastDataPoint.value);
        
        // 提取每个关键词的最新值（使用 formattedValue，按 URL 中的关键词顺序）
        const termValues = {};
        
        keywords.forEach((keyword, index) => {
          if (index >= valueArray.length) {
            console.warn(`关键词索引 ${index} 超出范围，formattedValue数组长度: ${valueArray.length}`);
            return; // 索引超出范围
          }
          
          // 使用 formattedValue（字符串格式），转换为数字
          const valueStr = valueArray[index];
          const value = valueStr === null || valueStr === undefined || valueStr === '' 
            ? 0 
            : parseInt(valueStr, 10);
          
          console.log(`关键词[${index}]: "${keyword}" = ${value} (原始: "${valueStr}")`);
          
          // 只处理有效值（0-100范围内的数字）
          if (!isNaN(value) && value >= 0 && value <= 100) {
            const term = keyword.toLowerCase().trim();
            termValues[term] = value;
          } else {
            console.warn(`关键词[${index}]: "${keyword}" 的值无效: ${valueStr}`);
          }
        });
        
        // 保存完整的 timelineData（用于根据日期查找数据点）
        fullTimelineData = sortedTimeline;
        console.log('[扩展] 已保存完整 timelineData，共', fullTimelineData.length, '个数据点');
        
        // 更新API数据
        if (Object.keys(termValues).length > 0) {
          Object.assign(apiData, termValues);
          console.log('API数据更新:', termValues);
          console.log('完整apiData:', apiData);
          // 触发更新
          scheduleUpdateFromApi();
        } else {
          console.warn('没有提取到任何有效数据');
        }
      }
    } catch (e) {
      console.warn('解析API数据失败:', e);
      // 不输出完整文本，避免控制台被刷屏
    }
  }

  // 从 tooltip 中提取数据点信息，并在原生 tooltip 中插入转换后的数值
  function extractDataFromTooltip() {
    try {
      // 查找 Google Trends 的原生 tooltip（排除我们自己的悬浮窗）
      const tooltipSelectors = [
        '[role="tooltip"]',
        '[class*="tooltip"]',
        '[class*="hover"]'
      ];
      
      let nativeTooltipElement = null;
      
      // 方法1: 查找所有可能的 tooltip 元素
      for (const selector of tooltipSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          try {
            const style = window.getComputedStyle(el);
            const zIndex = parseInt(style.zIndex) || 0;
            const position = style.position;
            const display = style.display;
            const text = el.textContent?.trim() || '';
            
            // 排除我们自己的悬浮窗（包含"估算搜索量"）
            if (text.includes('估算搜索量')) {
              continue;
            }
            
            // 查找包含日期和数值的 tooltip（Google Trends 原生 tooltip）
            if ((position === 'absolute' || position === 'fixed') &&
                display !== 'none' &&
                text.length > 0 &&
                // 包含日期格式
                (/\d{4}年\d{1,2}月\d{1,2}日/.test(text) || /\d{4}-\d{2}-\d{2}/.test(text)) &&
                // 包含多个数值（多个词的数值）
                text.match(/\d{1,3}/g) && text.match(/\d{1,3}/g).length >= 2) {
              nativeTooltipElement = el;
              break;
            }
          } catch (e) {
            // 忽略错误
          }
        }
        if (nativeTooltipElement) break;
      }
      
      // 方法2: 如果没找到，查找所有包含日期和数值的 div
      if (!nativeTooltipElement) {
        const allDivs = document.querySelectorAll('div');
        for (const el of allDivs) {
          try {
            const style = window.getComputedStyle(el);
            const position = style.position;
            const display = style.display;
            const text = el.textContent?.trim() || '';
            
            // 排除我们自己的悬浮窗
            if (text.includes('估算搜索量') || el.id === 'trends-volume-overlay') {
              continue;
            }
            
            // 查找包含日期和数值的 tooltip
            if ((position === 'absolute' || position === 'fixed') &&
                display !== 'none' &&
                text.length > 0 &&
                /\d{4}年\d{1,2}月\d{1,2}日/.test(text) &&
                text.match(/\d{1,3}/g) && text.match(/\d{1,3}/g).length >= 2) {
              nativeTooltipElement = el;
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      if (!nativeTooltipElement) {
        return; // 没有找到原生 tooltip
      }
      
      const tooltipText = nativeTooltipElement.textContent || '';
      
      // 从 tooltip 文本中提取数值
      // tooltip 格式通常是：
      // "2025年11月19日 11:00\nGPTs\n14\nCasual Games\n6\nveo 3\n85\nnano banana 2\n13"
      const termValuesFromTooltip = {};
      const lines = tooltipText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      
      // 提取日期和数值
      let currentTerm = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // 跳过日期行
        if (/\d{4}年\d{1,2}月\d{1,2}日/.test(line)) {
          continue;
        }
        
        // 检查是否是数值（1-100之间的数字）
        const numMatch = line.match(/^(\d{1,3})$/);
        if (numMatch && currentTerm) {
          const value = parseInt(numMatch[1], 10);
          if (value >= 0 && value <= 100) {
            termValuesFromTooltip[currentTerm.toLowerCase().trim()] = value;
            currentTerm = null; // 重置
          }
        } else if (line.length > 0 && !/^\d+$/.test(line)) {
          // 可能是词名（不是纯数字）
          currentTerm = line;
        }
      }
      
      // 如果上面的方法没提取到，尝试另一种格式（"词名: 数值"）
      if (Object.keys(termValuesFromTooltip).length === 0) {
        lines.forEach(line => {
          const match = line.match(/^([^:：\d]+?)\s*[:：]\s*(\d{1,3})$/);
          if (match) {
            const term = match[1].trim();
            const value = parseInt(match[2], 10);
            if (!isNaN(value) && value >= 0 && value <= 100) {
              termValuesFromTooltip[term.toLowerCase().trim()] = value;
            }
          }
        });
      }
      
      // 提取日期（支持中文和英文格式）
      let dateMatch = tooltipText.match(/(\d{4}年\d{1,2}月\d{1,2}日(?:至\d{1,2}日)?)/);
      if (!dateMatch) {
        dateMatch = tooltipText.match(/(\d{4}-\d{2}-\d{2})/);
      }
      if (!dateMatch) {
        dateMatch = tooltipText.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
      }
      
      const dateStr = dateMatch ? dateMatch[1] : null;
      
      // 如果提取到数值，计算搜索量并在原生 tooltip 中插入
      if (Object.keys(termValuesFromTooltip).length > 0) {
        currentHoverData = {
          date: dateStr || '未知日期',
          values: termValuesFromTooltip,
          dataPoint: null
        };
        
        // 在原生 tooltip 中插入转换后的数值
        enhanceNativeTooltipWithVolume(nativeTooltipElement, termValuesFromTooltip, dateStr);
        
        scheduleUpdate();
        return;
      }
      
      // 如果直接从 tooltip 提取失败，尝试从 timelineData 中查找
      if (dateStr && fullTimelineData.length > 0) {
        let matchedDataPoint = null;
        for (const point of fullTimelineData) {
          if (point.formattedTime && point.formattedTime.includes(dateStr)) {
            matchedDataPoint = point;
            break;
          }
          // 也尝试匹配部分日期（处理日期范围的情况）
          if (dateStr.includes('至')) {
            const startDate = dateStr.split('至')[0];
            if (point.formattedTime && point.formattedTime.includes(startDate)) {
              matchedDataPoint = point;
              break;
            }
          }
        }
        
        if (matchedDataPoint) {
          // 精简日志：只在调试时输出
          // console.log('[扩展] 从 timelineData 找到匹配的数据点');
          
          // 使用保存的关键词顺序（keywordsOrder）
          if (matchedDataPoint.formattedValue && Array.isArray(matchedDataPoint.formattedValue)) {
            const valueArray = matchedDataPoint.formattedValue;
            const termValues = {};
            
            if (keywordsOrder.length > 0 && keywordsOrder.length === valueArray.length) {
              keywordsOrder.forEach((term, index) => {
                const valueStr = valueArray[index];
                const value = valueStr === null || valueStr === undefined || valueStr === '' 
                  ? 0 
                  : parseInt(valueStr, 10);
                if (!isNaN(value) && value >= 0 && value <= 100) {
                  termValues[term] = value;
                }
              });
              
              if (Object.keys(termValues).length > 0) {
                currentHoverData = {
                  date: matchedDataPoint.formattedTime,
                  values: termValues,
                  dataPoint: matchedDataPoint
                };
                console.log('[扩展] ========== 更新悬停数据（从 timelineData）==========');
                console.log('[扩展] 日期:', currentHoverData.date);
                console.log('[扩展] 各词数值:', currentHoverData.values);
                scheduleUpdate();
              }
            }
          }
        } else {
          console.log('[扩展] 在 timelineData 中未找到匹配的数据点');
        }
      }
    } catch (e) {
      console.warn('[扩展] 从 tooltip 提取数据失败:', e);
    }
  }

  // 从API数据更新悬浮窗
  function scheduleUpdateFromApi() {
    if (Object.keys(apiData).length === 0) {
      console.warn('scheduleUpdateFromApi: apiData为空');
      return;
    }
    
    console.log('scheduleUpdateFromApi: 使用API数据渲染', apiData);
    
    // 查找参照词
    const reference = findReferenceTerm(apiData);
    
    // 渲染数据，使用特殊标记确保这是API数据（最后一个时间点）
    render(apiData, "估算搜索量（最后时间点）", reference);
  }
  
  // 处理待处理的响应（在parseApiResponse定义后调用）
  function processPendingResponses() {
    if (pendingResponses.length > 0) {
      console.log(`[扩展] 处理 ${pendingResponses.length} 个待处理的响应`);
      pendingResponses.forEach(({ text, url }) => {
        try {
          parseApiResponse(text, url);
        } catch (e) {
          console.warn('[扩展] 处理待处理响应失败:', e);
        }
      });
      pendingResponses = [];
    }
  }
  
  // 从 Performance API 查找最近的 multiline 请求并重新获取
  async function fetchLatestMultilineFromPerformance() {
    try {
      console.log('[扩展] 尝试从 Performance API 查找最近的 multiline 请求...');
      
      // 获取所有网络请求
      const resources = performance.getEntriesByType('resource');
      console.log('[扩展] 找到', resources.length, '个网络请求');
      
      // 查找最近的 multiline 请求
      let latestMultiline = null;
      let latestTime = 0;
      
      for (const resource of resources) {
        const resourceName = resource.name || '';
        // 减少日志输出，只检查 multiline 请求
        if (resourceName.includes('/trends/api/widgetdata/multiline')) {
          console.log('[扩展] 找到 multiline 请求:', resourceName.substring(0, 200));
          const requestTime = resource.responseEnd || resource.startTime || 0;
          console.log('[扩展] 找到 multiline 请求:', resourceName.substring(0, 200), '时间:', requestTime);
          if (requestTime > latestTime) {
            latestTime = requestTime;
            latestMultiline = resource;
          }
        }
      }
      
      if (latestMultiline) {
        const multilineUrl = latestMultiline.name;
        console.log('[扩展] 找到最近的 multiline 请求:', multilineUrl.substring(0, 200));
        console.log('[扩展] 请求时间:', latestTime);
        
        // 尝试从缓存中获取响应（避免重复请求）
        try {
          console.log('[扩展] 开始从缓存获取 multiline 响应...');
          const response = await fetch(multilineUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Referer': window.location.href
            },
            credentials: 'include', // 包含 cookies
            cache: 'force-cache' // 强制使用缓存，避免重复请求
          });
          
          if (response.ok) {
            const text = await response.text();
            console.log('[扩展] ========== 从缓存获取的响应 ==========');
            console.log('[扩展] 响应URL:', multilineUrl.substring(0, 300));
            console.log('[扩展] 响应长度:', text.length);
            console.log('[扩展] 响应前500字符:', text.substring(0, 500));
            
            // 尝试解析并打印 timelineData 数组
            try {
              let jsonText = text.trim();
              
              // 移除 )]}' 前缀
              if (jsonText.startsWith(")]}'")) {
                jsonText = jsonText.substring(4).trim();
              }
              
              // 移除可能存在的逗号和换行符
              if (jsonText.startsWith(",")) {
                jsonText = jsonText.substring(1).trim();
              }
              if (jsonText.startsWith("\n")) {
                jsonText = jsonText.substring(1).trim();
              }
              
              // 再次检查并移除逗号（处理 )]}', 的情况）
              if (jsonText.startsWith(",")) {
                jsonText = jsonText.substring(1).trim();
              }
              
              const data = JSON.parse(jsonText);
              if (data.default && data.default.timelineData) {
                const timelineData = data.default.timelineData;
                console.log('[扩展] timelineData数组长度:', timelineData.length);
                
                // 按时间戳排序
                const sorted = [...timelineData].sort((a, b) => {
                  const timeA = parseInt(a.time) || 0;
                  const timeB = parseInt(b.time) || 0;
                  return timeA - timeB;
                });
                
                // 打印最后一个数据点
                const lastPoint = sorted[sorted.length - 1];
                console.log('[扩展] 最后一个时间点数据:');
                console.log('  时间:', lastPoint.time, lastPoint.formattedTime);
                console.log('  formattedValue:', lastPoint.formattedValue);
                console.log('  value:', lastPoint.value);
                console.log('  hasData:', lastPoint.hasData);
                
                // 打印最后3个数据点
                const lastFew = sorted.slice(-3);
                console.log('[扩展] 最后3个数据点:');
                lastFew.forEach((point, idx) => {
                  const actualIdx = sorted.length - 3 + idx;
                  console.log(`  [${actualIdx}] 时间: ${point.time} (${point.formattedTime})`);
                  console.log(`    formattedValue:`, point.formattedValue);
                  console.log(`    value:`, point.value);
                });
              }
            } catch (parseErr) {
              console.warn('[扩展] 预解析JSON失败:', parseErr);
            }
            
            parseApiResponse(text, multilineUrl);
          } else {
            console.warn('[扩展] 获取失败，状态码:', response.status, response.statusText);
          }
        } catch (e) {
          console.warn('[扩展] 获取请求失败:', e, e.stack);
        }
      } else {
        console.warn('[扩展] 未找到 multiline 请求，已检查', resources.length, '个请求');
        // 输出所有请求的 URL 以便调试
        const allUrls = resources.map(r => r.name).filter(Boolean);
        console.log('[扩展] 所有请求URL（前10个）:', allUrls.slice(0, 10));
      }
    } catch (e) {
      console.warn('[扩展] 从 Performance API 查找请求失败:', e, e.stack);
    }
  }

  // 3) 创建悬浮窗
  function ensureOverlay() {
    let el = document.getElementById("trends-volume-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "trends-volume-overlay";
      el.innerHTML = `
        <div class="title">估算搜索量</div>
        <div id="trends-volume-rows"></div>
        <div class="sub">基于参照词动态折算</div>
      `;
      document.body.appendChild(el);
      makeDraggable(el);
    }
    return el;
  }

  function makeDraggable(el) {
    let isDown = false, startX = 0, startY = 0, sx = 0, sy = 0;

    el.addEventListener("mousedown", e => {
      // 如果点击的是内容区域，不拖拽
      if (e.target.closest('#trends-volume-rows')) {
        return;
      }
      isDown = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      sx = rect.left;
      sy = rect.top;
      e.preventDefault();
      el.style.cursor = 'grabbing';
    });

    window.addEventListener("mousemove", e => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = (sx + dx) + "px";
      el.style.top = (sy + dy) + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    });

    window.addEventListener("mouseup", () => {
      isDown = false;
      el.style.cursor = 'move';
    });
  }

  // 4) 从页面读取颜色（从 SVG 路径或样式）
  function updateTermColors() {
    // 尝试从图例中读取颜色
    const legendItems = document.querySelectorAll('[role="listitem"], .legend-item, [class*="legend"]');
    legendItems.forEach(item => {
      const text = item.textContent?.trim().toLowerCase();
      if (!text) return;
      
      // 查找颜色指示器（通常是圆形或矩形）
      const colorIndicator = item.querySelector('circle, rect, [class*="color"], [style*="fill"], [style*="background"]');
      if (colorIndicator) {
        const style = window.getComputedStyle(colorIndicator);
        const fill = style.fill || style.backgroundColor || colorIndicator.getAttribute('fill');
        if (fill && fill !== 'none' && fill !== 'transparent') {
          // 匹配术语名称
          Object.keys(termColors).forEach(term => {
            if (text.includes(term.toLowerCase())) {
              termColors[term] = fill;
            }
          });
        }
      }
    });
  }

  // 5) 解析当前图例/提示框中的指数值
  function readLegendValues() {
    const values = {};
    
    // 策略1: 查找 Google Trends 的工具提示（鼠标悬停时显示的框）
    // Google Trends 通常使用特定的 DOM 结构，尝试多种选择器
    const tooltipSelectors = [
      '[role="tooltip"]',
      '.trends-tooltip',
      '[class*="tooltip"]',
      '[class*="hover"]',
      '[class*="popup"]',
      'div[style*="position"][style*="absolute"]', // 绝对定位的弹出框
    ];
    
    let tooltipContainer = null;
    for (const selector of tooltipSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const style = window.getComputedStyle(el);
        // 检查是否是可见的弹出框（通常有较高的 z-index 和绝对定位）
        if (style.display !== 'none' && 
            style.visibility !== 'hidden' &&
            (style.position === 'absolute' || style.position === 'fixed') &&
            parseInt(style.zIndex) > 1000) {
          tooltipContainer = el;
          break;
        }
      }
      if (tooltipContainer) break;
    }

    // 从工具提示中提取数据
    if (tooltipContainer) {
      const text = tooltipContainer.textContent || '';
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      
      // 尝试匹配所有已知术语
      const allTerms = Object.keys(termColors);
      for (const line of lines) {
        for (const term of allTerms) {
          // 匹配模式：术语名称后跟冒号/数字，或直接跟数字
          const patterns = [
            new RegExp(`^${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：]?\\s*(\\d{1,3})`, "i"),
            new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d{1,3})`, "i"),
          ];
          
          for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) {
              const num = parseInt(match[1], 10);
              if (!isNaN(num) && num >= 0 && num <= 100) {
                values[term] = num;
                break;
              }
            }
          }
        }
      }
      
      // 如果没找到已知术语，尝试提取所有"文本: 数字"格式的数据
      if (Object.keys(values).length === 0) {
        for (const line of lines) {
          const match = line.match(/^([^:：\d]+?)\s*[:：]?\s*(\d{1,3})$/);
          if (match) {
            const term = match[1].trim().toLowerCase();
            const num = parseInt(match[2], 10);
            if (term.length > 0 && term.length < 100 && !isNaN(num) && num >= 0 && num <= 100) {
              values[term] = num;
              // 为新术语分配颜色
              if (!termColors[term]) {
                const colors = Object.values(DEFAULT_COLORS);
                const index = Object.keys(values).length - 1;
                termColors[term] = colors[index % colors.length] || "#999999";
              }
            }
          }
        }
      }
    }

    // 策略2: 从图例中读取（页面上的图例列表）
    if (Object.keys(values).length === 0) {
      const legendSelectors = [
        '[role="list"]',
        '[role="listitem"]',
        '[class*="legend"]',
        '[class*="series"]',
        '[class*="label"]',
      ];
      
      for (const selector of legendSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim() || '';
          if (text.length === 0 || text.length > 200) continue;
          
          // 检查是否包含已知术语
          for (const term of Object.keys(termColors)) {
            if (text.toLowerCase().includes(term.toLowerCase())) {
              // 查找数字（通常在术语后面）
              const numMatch = text.match(/(\d{1,3})/);
              if (numMatch) {
                const num = parseInt(numMatch[1], 10);
                if (!isNaN(num) && num >= 0 && num <= 100) {
                  values[term] = num;
                }
              }
            }
          }
        }
      }
    }

    // 策略3: 从平均值条形图中读取（页面左侧的小条形图）
    if (Object.keys(values).length === 0) {
      const avgValues = readAverages();
      Object.assign(values, avgValues);
    }

    return values;
  }

  // 6) 解析"平均值"小条图
  function readAverages() {
    const averages = {};
    
    // 查找包含"平均值"、"Average"、"平均"等关键词的区域
    const avgKeywords = ['平均值', 'average', '平均', 'mean', 'avg'];
    const avgNodes = Array.from(document.querySelectorAll('*'))
      .filter(n => {
        const text = (n.textContent || '').toLowerCase();
        return avgKeywords.some(keyword => text.includes(keyword.toLowerCase()));
      });

    if (avgNodes.length > 0) {
      // 在包含平均值的区域附近查找数据
      const scope = avgNodes[0].closest('section, div, svg') || avgNodes[0].parentElement;
      if (scope) {
        const text = (scope.textContent || '').replace(/\s+/g, ' ').toLowerCase();
        
        Object.keys(termColors).forEach(term => {
          // 匹配模式：术语名称后跟数字（可能是平均值）
          const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(\\d{1,3})", "i");
          const match = text.match(regex);
          if (match) {
            const num = parseInt(match[1], 10);
            if (!isNaN(num) && num >= 0 && num <= 100) {
              averages[term] = num;
            }
          }
        });

        // 如果找到了 Casual Games 的平均值，更新校准系数
        if (averages["casual games"]) {
          CAL_FACTOR = 1250 / averages["casual games"];
          // 更新悬浮窗中的系数显示
          const overlay = document.getElementById("trends-volume-overlay");
          if (overlay) {
            const subEl = overlay.querySelector(".sub");
            if (subEl) {
              subEl.textContent = `基于线性映射：指数 × ${CAL_FACTOR.toFixed(2)} (校准: Casual Games 平均 ${averages["casual games"]} → 1250次/日)`;
            }
          }
        }
      }
    }

    return averages;
  }

  // 7) 获取所有可见的搜索词（动态检测，不硬编码）
  function detectSearchTerms() {
    const terms = new Set();
    
    // 从图例中检测
    const legendItems = document.querySelectorAll('[role="listitem"], [class*="legend"], [class*="series"]');
    legendItems.forEach(item => {
      const text = item.textContent?.trim();
      if (text && text.length > 0 && text.length < 100) {
        // 排除纯数字或特殊字符
        if (!/^\d+$/.test(text) && !/^[^\w\s]+$/.test(text)) {
          terms.add(text);
        }
      }
    });

    // 从工具提示中检测
    const tooltips = document.querySelectorAll('[role="tooltip"], [class*="tooltip"]');
    tooltips.forEach(tooltip => {
      const lines = (tooltip.textContent || '').split('\n');
      lines.forEach(line => {
        const match = line.match(/^([^:：\d]+?)\s*[:：]?\s*(\d+)/);
        if (match) {
          const term = match[1].trim();
          if (term.length > 0 && term.length < 100) {
            terms.add(term);
          }
        }
      });
    });

    // 更新颜色映射（为新检测到的术语分配颜色）
    Array.from(terms).forEach((term, index) => {
      if (!termColors[term.toLowerCase()]) {
        const colors = Object.values(DEFAULT_COLORS);
        termColors[term.toLowerCase()] = colors[index % colors.length] || "#999999";
      }
    });

    return Array.from(terms);
  }

  // 8) 渲染（使用基于参照词的折算逻辑）
  function render(values, titleNote, reference) {
    const overlay = ensureOverlay();
    const rowsEl = overlay.querySelector("#trends-volume-rows");
    
    if (!rowsEl) return;

    // 如果没有值，尝试检测页面上的搜索词
    const detectedTerms = Object.keys(values).length === 0 ? detectSearchTerms() : Object.keys(values);
    
    if (detectedTerms.length === 0 && Object.keys(values).length === 0) {
      rowsEl.innerHTML = '<div class="empty">等待趋势数据加载...</div>';
      return;
    }

    // 使用检测到的术语或已知的术语
    const termsToShow = Object.keys(values).length > 0 ? Object.keys(values) : detectedTerms;
    
    const html = termsToShow.map(term => {
      const termLower = term.toLowerCase();
      const idx = values[termLower] || values[term];
      
      // 计算搜索量（使用比例换算，格式化为 xxK）
      let dailySearchFormatted = null;
      let monthlySearchFormatted = null;
      
      if (typeof idx === "number" && idx >= 0 && idx <= 100) {
        let dailySearch = null;
        let monthlySearch = null;
        
        if (reference) {
          // 使用参照词计算（比例换算）
          const isReferenceTerm = termLower === reference.term || 
                                 termLower.includes(reference.term) || 
                                 reference.term.includes(termLower);
          
          if (isReferenceTerm) {
            // 如果是参照词本身，使用已知的搜索量
            dailySearch = reference.dailySearch;
          } else {
            // 其他词：根据与参照词的比例计算
            // 公式：当前词的搜索量 = 参照词搜索量 × (当前词图表值 / 参照词图表值)
            if (reference.chartValue > 0) {
              dailySearch = reference.dailySearch * (idx / reference.chartValue);
            } else {
              dailySearch = 0;
            }
          }
        } else {
          // 没有参照词，使用默认换算系数
          dailySearch = idx * CAL_FACTOR;
        }
        
        // 计算月搜索量（按30天计算）
        monthlySearch = dailySearch * 30;
        
        // 格式化为 xxK 格式
        dailySearchFormatted = formatToK(dailySearch);
        monthlySearchFormatted = formatToK(monthlySearch);
      }
      
      const color = termColors[termLower] || termColors[term] || "#999999";
      const displayTerm = term.length > 20 ? term.substring(0, 17) + "..." : term;

      return `
        <div class="row">
          <div class="term">
            <span class="dot" style="background:${color}"></span>
            <span>${displayTerm}</span>
          </div>
              <div class="value">
                ${idx != null ? `${idx}` : "-"}
                ${dailySearchFormatted != null ? ` → ${dailySearchFormatted}/日` : ""}
                ${monthlySearchFormatted != null ? ` (${monthlySearchFormatted}/月)` : ""}
              </div>
        </div>
      `;
    }).join("");

    rowsEl.innerHTML = html;

    if (titleNote) {
      const titleEl = overlay.querySelector(".title");
      if (titleEl) {
        titleEl.textContent = titleNote;
      }
    }
    
    // 更新说明文字
    const subEl = overlay.querySelector(".sub");
    if (subEl) {
      if (reference) {
        const refDailyFormatted = formatToK(reference.dailySearch);
        subEl.textContent = `基于参照词: ${reference.name} (${reference.chartValue} → ${refDailyFormatted}/日)`;
      } else {
        subEl.textContent = `基于线性映射: 指数 × ${CAL_FACTOR.toFixed(2)}`;
      }
    }
  }

  // 9) 在原生 tooltip 中插入转换后的数值
  function enhanceNativeTooltipWithVolume(tooltipElement, termValues, dateStr) {
    try {
      // 清除之前的增强标记（如果 tooltip 内容已更新）
      const currentText = tooltipElement.textContent || '';
      const cachedText = tooltipContentCache.get(tooltipElement);
      if (cachedText !== currentText) {
        // 内容已更新，清除之前的增强标记
        tooltipElement.dataset.enhanced = 'false';
        // 移除之前添加的转换值（查找包含 "→" 的 span）
        const existingSpans = tooltipElement.querySelectorAll('span[style*="margin-left"]');
        existingSpans.forEach(span => {
          if (span.textContent.includes('→')) {
            span.remove();
          }
        });
      }
      
      // 检查是否已经处理过（避免重复处理）
      if (tooltipElement.dataset.enhanced === 'true') {
        return;
      }
      
      // 查找参照词
      const reference = findReferenceTerm(termValues);
      
      // 遍历 tooltip 的所有文本节点，找到数值并插入转换后的值
      const walker = document.createTreeWalker(
        tooltipElement,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            const text = node.textContent?.trim() || '';
            // 只处理包含 1-100 数字的文本节点
            if (/^\d{1,3}$/.test(text)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );
      
      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }
      
      // 为每个数值节点添加转换后的值
      textNodes.forEach((textNode, index) => {
        const value = parseInt(textNode.textContent.trim(), 10);
        if (isNaN(value) || value < 0 || value > 100) {
          return;
        }
        
        // 找到对应的词（通过查找前面的文本节点）
        let term = null;
        let prevNode = textNode.previousSibling;
        while (prevNode) {
          if (prevNode.nodeType === Node.TEXT_NODE) {
            const prevText = prevNode.textContent?.trim() || '';
            if (prevText.length > 0 && !/^\d+$/.test(prevText) && !/\d{4}年/.test(prevText)) {
              term = prevText;
              break;
            }
          } else if (prevNode.nodeType === Node.ELEMENT_NODE) {
            const prevText = prevNode.textContent?.trim() || '';
            if (prevText.length > 0 && !/^\d+$/.test(prevText) && !/\d{4}年/.test(prevText)) {
              // 尝试从元素中找到词名
              const lines = prevText.split('\n');
              for (const line of lines) {
                if (line.length > 0 && !/^\d+$/.test(line) && !/\d{4}年/.test(line)) {
                  term = line;
                  break;
                }
              }
              if (term) break;
            }
          }
          prevNode = prevNode.previousSibling;
        }
        
        // 如果找不到词，尝试从 termValues 中匹配（通过值匹配）
        if (!term) {
          for (const [t, v] of Object.entries(termValues)) {
            if (v === value) {
              term = t;
              break;
            }
          }
        }
        
        if (!term) return;
        
        // 计算搜索量
        const termLower = term.toLowerCase().trim();
        let dailySearch = null;
        let monthlySearch = null;
        
        if (reference) {
          const isReferenceTerm = termLower === reference.term || 
                                 termLower.includes(reference.term) || 
                                 reference.term.includes(termLower);
          
          if (isReferenceTerm) {
            dailySearch = reference.dailySearch;
          } else if (reference.chartValue > 0) {
            dailySearch = reference.dailySearch * (value / reference.chartValue);
          }
        } else {
          dailySearch = value * CAL_FACTOR;
        }
        
        if (dailySearch !== null) {
          monthlySearch = dailySearch * 30;
          const dailyFormatted = formatToK(dailySearch);
          const monthlyFormatted = formatToK(monthlySearch);
          
          // 在数值后面插入转换后的值
          const span = document.createElement('span');
          span.style.marginLeft = '4px';
          span.style.color = '#666';
          span.style.fontSize = '0.9em';
          span.textContent = ` → ${dailyFormatted}/日 (${monthlyFormatted}/月)`;
          
          // 插入到数值节点后面
          if (textNode.parentNode) {
            textNode.parentNode.insertBefore(span, textNode.nextSibling);
          }
        }
      });
      
      // 标记为已处理并缓存内容
      tooltipElement.dataset.enhanced = 'true';
      tooltipContentCache.set(tooltipElement, tooltipElement.textContent);
    } catch (e) {
      console.warn('[扩展] 增强原生 tooltip 时出错:', e);
    }
  }

  // 10) 修改原生tooltip，在数值后添加计算结果（旧版本，保留兼容）
  const tooltipContentCache = new WeakMap(); // 缓存tooltip的内容哈希，用于检测内容变化
  
  function findGoogleTrendsTooltip() {
    // Google Trends的tooltip特征：
    // 1. 白色背景的矩形框
    // 2. 绝对定位，高z-index
    // 3. 包含日期和搜索词+数值的列表
    // 4. 只在鼠标悬停在图表上时出现
    
    // 策略1: 使用多种选择器查找tooltip
    const tooltipSelectors = [
      '[role="tooltip"]',
      '[class*="tooltip"]',
      '[class*="hover"]',
      '[class*="popup"]',
      'div[style*="position: absolute"]',
      'div[style*="position:fixed"]',
    ];
    
    const candidates = [];
    
    // 先尝试通过选择器查找
    for (const selector of tooltipSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          try {
            // 安全地获取样式，避免触发className访问
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && 
                style.visibility !== 'hidden' &&
                (style.position === 'absolute' || style.position === 'fixed')) {
              // 安全地获取文本内容，不访问className
              const text = el.textContent || '';
              // 检查是否包含Google Trends tooltip的特征
              if (text.includes('年') || text.includes('月') || text.includes('日') || /[:：]\s*[<]?\d/.test(text)) {
                candidates.push(el);
              }
            }
          } catch (e) {
            // 忽略单个元素的错误，继续查找
            continue;
          }
        }
      } catch (e) {
        // 忽略选择器错误，继续下一个选择器
        continue;
      }
    }
    
    // 策略2: 如果选择器没找到，遍历所有元素查找（但更保守，避免影响性能）
    if (candidates.length === 0) {
      try {
        // 限制搜索范围，只搜索body下的直接子元素，避免遍历整个DOM树
        const bodyChildren = Array.from(document.body.children || []);
        for (const el of bodyChildren) {
          try {
            const style = window.getComputedStyle(el);
            
            // 必须是可见的绝对定位元素
            if (style.display === 'none' || 
                style.visibility === 'hidden' ||
                (style.position !== 'absolute' && style.position !== 'fixed')) {
              continue;
            }
            
            // 必须有较高的z-index（tooltip通常在顶层）
            const zIndex = parseInt(style.zIndex) || 0;
            if (zIndex < 1000) {
              continue;
            }
            
            // 检查内容特征：包含日期格式和数值（不访问className）
            const text = el.textContent || '';
            const hasDate = /年|月|日|至/.test(text);
            const hasColonFormat = /[:：]\s*[<]?\d/.test(text); // 包含"词: 数字"格式
            const hasNumbers = /[<]?\d{1,3}/.test(text);
            
            // 如果满足多个特征，很可能是tooltip
            if (hasDate && hasColonFormat && hasNumbers && text.length < 1000 && text.length > 20) {
              // 进一步检查：是否包含搜索词和数值的对应关系
              const lines = text.split('\n').filter(l => l.trim());
              let hasTermValuePairs = false;
              for (const line of lines) {
                // 匹配 "搜索词: 数字" 或 "搜索词: <数字" 格式
                if (/[^\d:：\s]+[:：]\s*[<]?\d{1,3}/.test(line.trim())) {
                  hasTermValuePairs = true;
                  break;
                }
              }
              
              if (hasTermValuePairs) {
                candidates.push(el);
              }
            }
          } catch (e) {
            // 忽略单个元素的错误，继续查找
            continue;
          }
        }
      } catch (e) {
        // 忽略查找错误
        console.warn('查找tooltip时出错:', e);
      }
    }
    
    // 返回最可能的tooltip（通常是z-index最高的，或者最匹配的）
    if (candidates.length > 0) {
      // 优先选择包含日期范围的tooltip
      const withDate = candidates.filter(el => {
        const text = el.textContent || '';
        return /年.*月.*日.*至/.test(text) || /年.*月.*日/.test(text);
      });
      
      if (withDate.length > 0) {
        return withDate[0];
      }
      
      // 否则选择z-index最高的
      candidates.sort((a, b) => {
        const zA = parseInt(window.getComputedStyle(a).zIndex) || 0;
        const zB = parseInt(window.getComputedStyle(b).zIndex) || 0;
        return zB - zA;
      });
      return candidates[0];
    }
    
    return null;
  }
  
  // 解析tooltip中的词和数值
  function parseTooltipData(text) {
    const data = {};
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    
    for (const line of lines) {
      // 匹配 "搜索词: 数字" 或 "搜索词: <数字" 格式
      const match = line.match(/^([^:：\d<>]+?)\s*[:：]\s*([<])?(\d{1,3})/);
      if (match) {
        const term = match[1].trim().toLowerCase();
        const lessThan = match[2] || '';
        const value = parseInt(match[3], 10);
        if (!isNaN(value) && value >= 0 && value <= 100) {
          data[term] = {
            value: value,
            lessThan: lessThan,
            originalLine: line
          };
        }
      }
    }
    
    return data;
  }
  
  // 格式化数字为 xxK 格式
  function formatToK(num) {
    if (num === null || num === undefined || isNaN(num)) {
      return null;
    }
    
    if (num < 1000) {
      return Math.round(num).toString();
    } else if (num < 10000) {
      // 1K - 9.9K，保留一位小数
      return (num / 1000).toFixed(1) + 'K';
    } else if (num < 1000000) {
      // 10K - 999K，保留整数
      return Math.round(num / 1000) + 'K';
    } else {
      // 1M+，保留一位小数
      return (num / 1000000).toFixed(1) + 'M';
    }
  }

  // 查找参照词（支持模糊匹配）
  function findReferenceTerm(data) {
    // data可能是对象，键是term，值是数值；或者是对象，键是term，值是对象{value, lessThan}
    for (const [term, info] of Object.entries(data)) {
      const termLower = term.toLowerCase().trim();
      
      // 获取数值（支持两种格式）
      let value = null;
      if (typeof info === 'number') {
        value = info;
      } else if (info && typeof info === 'object' && 'value' in info) {
        value = info.value;
      }
      
      if (value === null || value === undefined) {
        continue;
      }
      
      // 精确匹配
      if (REFERENCE_TERMS[termLower]) {
        return {
          term: termLower,
          chartValue: value,
          dailySearch: REFERENCE_TERMS[termLower].daily,
          name: REFERENCE_TERMS[termLower].name
        };
      }
      
      // 模糊匹配：检查是否包含参照词的关键字
      for (const [refKey, refInfo] of Object.entries(REFERENCE_TERMS)) {
        // 检查term是否包含参照词，或参照词是否包含term
        if (termLower.includes(refKey) || refKey.includes(termLower)) {
          return {
            term: termLower,
            chartValue: value,
            dailySearch: refInfo.daily,
            name: refInfo.name
          };
        }
      }
    }
    return null;
  }
  
  function enhanceNativeTooltip() {
    // 查找Google Trends的tooltip
    const tooltipContainer = findGoogleTrendsTooltip();
    
    if (!tooltipContainer) {
      return; // 没有找到tooltip
    }

    const originalText = tooltipContainer.textContent || '';
    
    // 检查是否已经包含计算结果
    const cachedContent = tooltipContentCache.get(tooltipContainer);
    if (originalText.includes('次/日') || originalText.includes('≈')) {
      // 如果内容未变化，说明已经处理过，跳过
      if (cachedContent === originalText) {
        return;
      }
      // 内容变化了，需要重新处理
    }

    // 检查是否包含趋势值（0-100范围内的数字，包括<1这种格式）
    const hasTrendValue = /[<]?\d{1,3}/.test(originalText);
    if (!hasTrendValue) {
      return; // 不包含趋势值，跳过
    }
    
    // 解析tooltip中的所有词和数值
    const tooltipData = parseTooltipData(originalText);
    if (Object.keys(tooltipData).length === 0) {
      return; // 无法解析数据
    }
    
    // 查找参照词
    const reference = findReferenceTerm(tooltipData);
    if (!reference) {
      // 如果没有找到参照词，使用默认换算系数
      console.warn('未找到参照词（GPTs或Casual Games），使用默认换算系数');
    }

    // 通过修改文本节点来处理（保持DOM结构，不修改className等属性）
    // 使用try-catch包裹，避免影响Google Trends的正常运行
    try {
      const walker = document.createTreeWalker(
        tooltipContainer,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            // 跳过已经处理过的节点（包含计算结果）
            if (node.textContent && (node.textContent.includes('次/日') || node.textContent.includes('≈'))) {
              // 检查是否是已处理过的格式
              if (node.textContent.match(/\(≈\d+次\/日\)/)) {
                return NodeFilter.FILTER_REJECT; // 已处理，跳过
              }
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        },
        false
      );

      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }

      let hasChanges = false;
      textNodes.forEach(textNode => {
        try {
          // 确保是纯文本节点，不是其他类型的节点
          if (textNode.nodeType !== Node.TEXT_NODE) {
            return;
          }
          
          // 检查父元素，确保不是SVG或其他特殊元素
          const parent = textNode.parentElement;
          if (parent) {
            // 跳过SVG元素，避免影响其内部结构
            if (parent.tagName === 'svg' || parent.closest('svg')) {
              return;
            }
            // 安全地检查 className，避免触发 Google Trends 内部错误
            try {
              if (parent.className && typeof parent.className !== 'string') {
                return;
              }
            } catch (e) {
              // 如果访问 className 出错，直接跳过
              return;
            }
          }
          
          let text = textNode.textContent;
          if (!text || text.trim().length === 0) {
            return;
          }
          
          // 如果文本已经包含计算结果，跳过
          if (text.includes('次/日') || text.includes('≈')) {
            return;
          }

          // 匹配模式：
          // 1. "搜索词: 数字" 或 "搜索词: <数字" 格式（如 "GPTs: 1" 或 "sora 2 ai video generator: <1"）
          // 2. 单独的数字（但不在日期中）
          const patterns = [
            // 匹配 "术语: 数字" 或 "术语: <数字" 格式
            /([^\d:：\n\r<>]+?)\s*[:：]\s*([<])?(\d{1,3})(?![^\d]*次\/日)(?![^\d]*≈)(?=\s|$|,|，|。|<\/|$)/g,
            // 匹配单独的数字（但不在日期中，且不在已处理的格式中）
            /(?:^|\s|>)([<])?(\d{1,3})(?![^\d]*年)(?![^\d]*月)(?![^\d]*日)(?![^\d]*次\/日)(?![^\d]*≈)(?=\s|$|,|，|。|<\/|$)/g,
          ];

          patterns.forEach(pattern => {
            text = text.replace(pattern, (match, p1, p2, p3) => {
              let numStr, prefix = '', lessThan = '';
              
              if (p3 !== undefined) {
                // 模式1: 文本: <数字 或 文本: 数字
                prefix = p1 ? p1.trim() : '';
                lessThan = p2 || '';
                numStr = p3;
              } else if (p2 !== undefined) {
                // 模式2: <数字 或 数字（单独）
                lessThan = p1 || '';
                numStr = p2;
              } else {
                return match; // 格式不匹配
              }

              const num = parseInt(numStr, 10);
              if (!isNaN(num) && num >= 0 && num <= 100) {
                // 计算搜索量
                let dailySearch = 0;
                let monthlySearch = 0;
                
                if (reference) {
                  // 使用参照词计算
                  const termLower = prefix.toLowerCase().trim();
                  
                  // 检查是否是参照词本身（支持模糊匹配）
                  const isReferenceTerm = termLower === reference.term || 
                                         termLower.includes(reference.term) || 
                                         reference.term.includes(termLower);
                  
                  if (isReferenceTerm) {
                    // 如果是参照词本身，使用已知的搜索量
                    dailySearch = reference.dailySearch;
                  } else {
                    // 其他词：根据与参照词的比例计算
                    // dailySearch = reference.dailySearch * (num / reference.chartValue)
                    if (reference.chartValue > 0) {
                      dailySearch = Math.round(reference.dailySearch * (num / reference.chartValue));
                    } else {
                      dailySearch = 0;
                    }
                  }
                } else {
                  // 没有参照词，使用默认换算系数
                  dailySearch = Math.round(num * CAL_FACTOR);
                }
                
                // 计算月搜索量（按30天计算）
                monthlySearch = Math.round(dailySearch * 30);
                
                hasChanges = true;
                
                if (prefix) {
                  // 格式: "搜索词: <1" 或 "搜索词: 34"
                  return `${prefix}: ${lessThan}${numStr} (≈${dailySearch.toLocaleString('zh-CN')}次/日, ${monthlySearch.toLocaleString('zh-CN')}次/月)`;
                } else {
                  // 格式: "<1" 或 "34"（单独的数字）
                  const prefixChar = match[0] === '>' ? '>' : (match[0] === ' ' ? ' ' : '');
                  return `${prefixChar}${lessThan}${numStr} (≈${dailySearch.toLocaleString('zh-CN')}次/日, ${monthlySearch.toLocaleString('zh-CN')}次/月)`;
                }
              }
              
              return match;
            });
          });

          if (text !== textNode.textContent) {
            // 安全地修改文本内容，确保不会影响父元素的属性
            try {
              // 使用 nodeValue 而不是 textContent，更安全
              if (textNode.nodeValue !== null) {
                textNode.nodeValue = text;
                hasChanges = true;
              } else {
                textNode.textContent = text;
                hasChanges = true;
              }
            } catch (e) {
              // 如果修改失败，跳过这个节点
              console.warn('无法修改文本节点:', e);
            }
          }
        } catch (e) {
          // 忽略单个文本节点的错误，继续处理其他节点
          console.warn('处理文本节点时出错:', e);
        }
      });

      // 不再使用innerHTML修改，避免破坏DOM结构和className属性
      // 如果文本节点处理失败，说明tooltip结构特殊，跳过处理以避免影响Google Trends
      // if (!hasChanges) {
      //   // 已禁用innerHTML修改，避免破坏DOM结构
      // }
      
      // 缓存处理后的内容
      if (hasChanges) {
        tooltipContentCache.set(tooltipContainer, tooltipContainer.textContent);
      }
    } catch (e) {
      // 如果整个处理过程出错，记录但不影响Google Trends的正常运行
      console.warn('增强tooltip时出错:', e);
    }
  }

  // 10) 监听 DOM 变更和鼠标移动
  let updateTimer = null;
  let lastUpdateTime = 0;
  const MIN_UPDATE_INTERVAL = 1000; // 最小更新间隔 1秒，避免过度渲染和日志刷屏
  
  function scheduleUpdate(force = false) {
    const now = Date.now();
    if (!force && now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
      return; // 跳过过于频繁的更新
    }
    
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    updateTimer = setTimeout(() => {
      lastUpdateTime = Date.now();
      updateTermColors();
      
      // 暂时禁用原生tooltip修改，避免影响Google Trends
      // enhanceNativeTooltip();
      
      // 优先级：1. 鼠标悬停数据（currentHoverData） 2. API数据（最后时间点） 3. DOM解析数据
      let reference = null;
      
      if (currentHoverData && currentHoverData.values && Object.keys(currentHoverData.values).length > 0) {
        // 使用鼠标悬停位置的数据点
        // 减少日志输出，避免刷屏
        // console.log('scheduleUpdate: 使用鼠标悬停数据', currentHoverData);
        reference = findReferenceTerm(currentHoverData.values);
        const title = `估算搜索量（${currentHoverData.date}）`;
        render(currentHoverData.values, title, reference);
      } else if (Object.keys(apiData).length > 0) {
        // 使用API数据（最后时间点）
        // 减少日志输出，避免刷屏
        // console.log('scheduleUpdate: 使用API数据', apiData);
        reference = findReferenceTerm(apiData);
        render(apiData, "估算搜索量（最后时间点）", reference);
      } else {
        // 只在调试时输出日志，避免刷屏
        // console.log('scheduleUpdate: API数据为空，使用DOM数据');
        // 使用DOM解析的数据
        const legendVals = readLegendValues();
        
        // 查找参照词
        if (Object.keys(legendVals).length > 0) {
          reference = findReferenceTerm(legendVals);
          render(legendVals, "估算搜索量（当前时间点）", reference);
        } else {
          const avgVals = readAverages();
          if (Object.keys(avgVals).length > 0) {
            reference = findReferenceTerm(avgVals);
            render(avgVals, "估算搜索量（平均值）", reference);
          } else {
            // 尝试渲染检测到的术语（即使没有数值）
            render({}, "估算搜索量（等待数据）", null);
          }
        }
      }
    }, 100); // 防抖，100ms
  }

  const mo = new MutationObserver(scheduleUpdate);

  // tooltip 提取防抖计时器
  let tooltipExtractTimer = null;

  // 专门监听tooltip的MutationObserver
  const tooltipObserver = new MutationObserver((mutations) => {
    // 检查是否有新的tooltip出现或内容更新
    let shouldEnhance = false;
    let foundTooltip = false;
    
    try {
      mutations.forEach(mutation => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) { // Element node
              try {
                const style = window.getComputedStyle(node);
                const zIndex = parseInt(style.zIndex) || 0;
                if ((style.position === 'absolute' || style.position === 'fixed') &&
                    zIndex > 1000 &&
                    style.display !== 'none') {
                  const text = node.textContent?.trim() || '';
                  // 检查是否包含日期格式（更精确的判断）
                  if (text.length > 0 && (
                    /\d{4}年\d{1,2}月\d{1,2}日/.test(text) ||
                    /\d{4}-\d{2}-\d{2}/.test(text) ||
                    /[A-Za-z]+\s+\d{1,2},\s+\d{4}/.test(text)
                  )) {
                    shouldEnhance = true;
                    foundTooltip = true;
                    console.log('[扩展] MutationObserver 检测到可能的 tooltip，z-index:', zIndex, '文本:', text.substring(0, 100));
                  }
                }
              } catch (e) {
                // 忽略样式获取错误，避免影响Google Trends
              }
            }
          });
        }
        if (mutation.type === 'characterData' || mutation.type === 'childList') {
          // 文本内容变化，可能是tooltip更新
          // 但只在找到可能的 tooltip 时才触发
          if (foundTooltip) {
            shouldEnhance = true;
          }
        }
      });
    } catch (e) {
      // 忽略mutation处理错误，避免影响Google Trends
      console.warn('[扩展] 处理mutation时出错:', e);
    }
    
    if (shouldEnhance) {
      // 使用防抖，避免频繁调用
      if (tooltipExtractTimer) {
        clearTimeout(tooltipExtractTimer);
      }
      tooltipExtractTimer = setTimeout(() => {
        try {
          console.log('[扩展] MutationObserver 触发，开始提取 tooltip 数据...');
          // 从 tooltip 中提取数据点信息
          extractDataFromTooltip();
          // enhanceNativeTooltip(); // 暂时禁用原生 tooltip 修改
        } catch (e) {
          console.warn('[扩展] 处理 tooltip 时出错:', e);
        }
      }, 100); // 防抖延迟 100ms
    }
  });

  // 监听鼠标移动（当鼠标在图表上移动时，工具提示会更新）
  // 使用节流，避免过度触发
  let mouseMoveTimer = null;
  let mouseLeaveTimer = null;
  
  document.addEventListener("mousemove", (e) => {
    // 只在鼠标在图表区域移动时更新（粗略判断：不在悬浮窗上）
    if (e.target.closest('#trends-volume-overlay')) {
      return;
    }
    
    // 清除离开计时器
    if (mouseLeaveTimer) {
      clearTimeout(mouseLeaveTimer);
      mouseLeaveTimer = null;
    }
    
    if (mouseMoveTimer) {
      clearTimeout(mouseMoveTimer);
    }
    mouseMoveTimer = setTimeout(() => {
      // 鼠标移动时也尝试从 tooltip 提取数据（更频繁地检查）
      extractDataFromTooltip();
      scheduleUpdate();
    }, 200); // 鼠标移动时稍微延迟更新
  }, { passive: true });
  
  // 监听鼠标离开图表区域（延迟清除悬停数据）
  document.addEventListener("mouseleave", (e) => {
    // 延迟清除，避免快速移动时频繁清除
    if (mouseLeaveTimer) {
      clearTimeout(mouseLeaveTimer);
    }
    mouseLeaveTimer = setTimeout(() => {
      if (currentHoverData !== null) {
        console.log('[扩展] 鼠标离开图表区域，清除悬停数据');
        currentHoverData = null;
        scheduleUpdate();
      }
    }, 500); // 延迟 500ms，避免快速移动时误清除
  }, { passive: true });

  function start() {
    ensureOverlay();
    updateTermColors();
    
    // 不再重复设置拦截器，因为已经在页面加载前设置了
    // interceptNetworkRequests();
    
    // 处理在parseApiResponse定义前拦截到的响应
    processPendingResponses();
    
    // 如果 API 数据为空，尝试从 Performance API 获取（延迟更长时间，等待请求完成）
    if (Object.keys(apiData).length === 0) {
      console.log('[扩展] API数据为空，将在3秒后尝试从 Performance API 获取...');
      setTimeout(() => {
        if (Object.keys(apiData).length === 0) {
          console.log('[扩展] 延迟后仍无API数据，尝试从 Performance API 获取...');
          fetchLatestMultilineFromPerformance();
        } else {
          console.log('[扩展] 延迟期间已获取到API数据，无需从 Performance API 获取');
        }
      }, 3000); // 延迟3秒，等待 multiline 请求完成
    } else {
      console.log('[扩展] API数据已存在，无需从 Performance API 获取');
    }
    
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: false  // 不监听属性变化，避免影响Google Trends的className处理
    });

    // 启动tooltip监听器（只监听文本内容和子节点变化，不监听className，避免影响Google Trends）
    tooltipObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: false  // 不监听属性变化，避免影响Google Trends的className处理
    });

    // 初次渲染
    scheduleUpdate();
    
    // 完全禁用原生 tooltip 修改，避免触发 Google Trends 内部错误
    // setTimeout(() => enhanceNativeTooltip(), 500);

    // 不再定期轮询，只在 DOM 变化时更新（通过 MutationObserver）
  }

  // 等待页面加载完成
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // 页面可见性变化时重新检测
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleUpdate();
    }
  });

})();

