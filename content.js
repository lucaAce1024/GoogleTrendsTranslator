// content.js
(function() {
  'use strict';

  // 1) 参照词的已知搜索量（内置默认，可被存储覆盖并扩展）
  const DEFAULT_REFERENCE_TERMS = {
    'gpts': { daily: 5000, name: 'GPTs' },
    'casual games': { daily: 2500, name: 'Casual Games' }
  };
  let REFERENCE_TERMS = { ...JSON.parse(JSON.stringify(DEFAULT_REFERENCE_TERMS)) };

  /** 从 chrome.storage.local 加载参考词配置，用存储值覆盖默认 */
  function loadReferenceTermsFromStorage(callback) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('referenceTerms', function(data) {
        const base = JSON.parse(JSON.stringify(DEFAULT_REFERENCE_TERMS));
        if (data.referenceTerms && typeof data.referenceTerms === 'object') {
          for (const [key, val] of Object.entries(data.referenceTerms)) {
            if (!key || typeof val !== 'object') continue;
            const daily = Number(val.daily);
            const name = (val.name != null && String(val.name).trim()) ? String(val.name).trim() : key;
            if (!isNaN(daily) && daily >= 0) base[key] = { daily, name };
          }
        }
        REFERENCE_TERMS = base;
        if (typeof callback === 'function') callback();
      });
    } else {
      if (typeof callback === 'function') callback();
    }
  }

  /** 将当前参考词保存到 chrome.storage.local（存为可序列化副本并检查错误） */
  function saveReferenceTermsToStorage(terms, callback) {
    REFERENCE_TERMS = terms;
    var payload = {};
    try {
      payload = JSON.parse(JSON.stringify(terms));
    } catch (e) {
      if (typeof callback === 'function') callback();
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ referenceTerms: payload }, function() {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.warn('[扩展] 参考词保存失败:', chrome.runtime.lastError.message);
        }
        if (typeof callback === 'function') callback();
      });
    } else {
      if (typeof callback === 'function') callback();
    }
  }

  /** 判断是否为内置默认参考词（不可删除，可编辑） */
  function isBuiltinReferenceTerm(key) {
    return Object.prototype.hasOwnProperty.call(DEFAULT_REFERENCE_TERMS, key);
  }

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
  
  // 显示模式：'daily' 或 'monthly'，默认 'daily'
  let displayMode = 'daily';
  
  // 存储待处理的响应（在parseApiResponse定义前拦截到的请求）
  let pendingResponses = [];
  
  // 立即设置网络请求拦截器（在页面加载前就设置，确保能拦截到所有请求）
  (function setupInterceptorsEarly() {
    // 拦截 fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = args[0];
      const urlString = typeof url === 'string' ? url : (url && url.url ? url.url : '');
      
      if (urlString && urlString.includes('/trends/api/widgetdata/multiline')) {
        const fetchPromise = originalFetch.apply(this, args);
        
        // 异步处理响应，不阻塞原始请求
        fetchPromise.then(response => {
          if (!response.ok) {
            return;
          }
          
          // 克隆响应以便读取
          const clonedResponse = response.clone();
          clonedResponse.text().then(text => {
            try {
              // 如果parseApiResponse已定义，直接调用；否则保存待处理
              if (typeof parseApiResponse === 'function') {
                parseApiResponse(text, urlString);
              } else {
                pendingResponses.push({ text, url: urlString });
              }
            } catch (e) {
              console.warn('[扩展] 解析 fetch API响应失败:', e);
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
        const xhr = this;
        
        // 监听 load 事件
        xhr.addEventListener('load', function() {
          try {
            if (xhr.readyState === 4 && xhr.status === 200) {
              if (xhr.responseText) {
                // 如果parseApiResponse已定义，直接调用；否则保存待处理
                if (typeof parseApiResponse === 'function') {
                  parseApiResponse(xhr.responseText, xhr._url);
                } else {
                  pendingResponses.push({ text: xhr.responseText, url: xhr._url });
                }
              }
            }
          } catch (e) {
            console.warn('[扩展] 解析 XHR API响应失败:', e);
          }
        });
        
        xhr.addEventListener('error', function() {
          console.warn('[扩展] XHR 请求失败');
        });
      }
      return originalSend.apply(this, args);
    };
  })();

  // 拦截网络请求，获取Google Trends API数据
  function interceptNetworkRequests() {
    
    // 拦截 fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = args[0];
      if (typeof url === 'string' && url.includes('/trends/api/widgetdata/')) {
        return originalFetch.apply(this, args).then(response => {
          // 克隆响应以便读取
          const clonedResponse = response.clone();
          clonedResponse.text().then(text => {
            try {
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
        this.addEventListener('load', function() {
          try {
            if (this.responseText) {
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
    
  }

  // 从URL中解析搜索词
  function parseKeywordsFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const reqParam = urlObj.searchParams.get('req');
      if (!reqParam) {
        return [];
      }
      
      // req参数是URL编码的JSON，需要解码
      const decodedReq = decodeURIComponent(reqParam);
      const reqData = JSON.parse(decodedReq);
      
      // 从comparisonItem中提取搜索词
      const keywords = [];
      if (reqData.comparisonItem && Array.isArray(reqData.comparisonItem)) {
        reqData.comparisonItem.forEach((item, idx) => {
          if (item.complexKeywordsRestriction && 
              item.complexKeywordsRestriction.keyword && 
              Array.isArray(item.complexKeywordsRestriction.keyword)) {
            item.complexKeywordsRestriction.keyword.forEach(kw => {
              if (kw.value) {
                keywords.push(kw.value);
              }
            });
          } else {
            console.warn(`comparisonItem[${idx}] 没有有效的 keyword 结构`);
          }
        });
      } else {
        console.warn('reqData中没有comparisonItem或不是数组');
      }
      
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
        
        
        // 提取每个关键词的最新值（使用 formattedValue，按 URL 中的关键词顺序）
        const termValues = {};
        
        keywords.forEach((keyword, index) => {
          if (index >= valueArray.length) {
            console.warn(`关键词索引 ${index} 超出范围，formattedValue数组长度: ${valueArray.length}`);
            return; // 索引超出范围
          }
          
          // 使用 formattedValue（字符串格式），转换为数字（支持 "<1" 等格式）
          const valueStr = valueArray[index];
          let value;
          if (valueStr === null || valueStr === undefined || valueStr === '') {
            value = 0;
          } else if (typeof valueStr === 'string' && valueStr.trim().toLowerCase().startsWith('<')) {
            // "<1" 等表示小于某值，按 0 参与折算
            value = 0;
          } else {
            value = parseInt(String(valueStr).replace(/[<\s]/g, ''), 10);
          }
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
        
        // 更新API数据
        if (Object.keys(termValues).length > 0) {
          Object.assign(apiData, termValues);
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
        // 立即应用，使用 requestAnimationFrame 确保在渲染后执行
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            enhanceNativeTooltipWithVolume(nativeTooltipElement, termValuesFromTooltip, dateStr);
          });
        });
        
        // 使用 setInterval 持续检查并重新应用转换值（防止被 Google Trends 移除）
        // 清除之前的 interval（如果存在）
        if (nativeTooltipElement.dataset.checkIntervalId) {
          clearInterval(parseInt(nativeTooltipElement.dataset.checkIntervalId));
        }
        
        const checkInterval = setInterval(() => {
          // 检查 tooltip 是否仍然存在
          if (!document.body.contains(nativeTooltipElement)) {
            clearInterval(checkInterval);
            delete nativeTooltipElement.dataset.checkIntervalId;
            return;
          }
          
          // 检查是否有我们的转换值（使用更精确的选择器）
          const existingSpans = nativeTooltipElement.querySelectorAll('span[data-trends-volume="true"]');
          const hasOurSpans = existingSpans.length > 0;
          
          // 如果没有转换值，立即重新应用
          if (!hasOurSpans && Object.keys(termValuesFromTooltip).length > 0) {
            // 使用 requestAnimationFrame 确保在渲染后立即应用
            requestAnimationFrame(() => {
              enhanceNativeTooltipWithVolume(nativeTooltipElement, termValuesFromTooltip, dateStr);
            });
          }
        }, 50); // 每 50ms 检查一次，更频繁地重新应用
        
        // 保存 interval ID，以便后续清除
        nativeTooltipElement.dataset.checkIntervalId = checkInterval.toString();
        
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
          
          // 使用保存的关键词顺序（keywordsOrder）
          if (matchedDataPoint.formattedValue && Array.isArray(matchedDataPoint.formattedValue)) {
            const valueArray = matchedDataPoint.formattedValue;
            const termValues = {};
            
            if (keywordsOrder.length > 0 && keywordsOrder.length === valueArray.length) {
              keywordsOrder.forEach((term, index) => {
                const valueStr = valueArray[index];
                let value;
                if (valueStr === null || valueStr === undefined || valueStr === '') {
                  value = 0;
                } else if (typeof valueStr === 'string' && valueStr.trim().toLowerCase().startsWith('<')) {
                  value = 0;
                } else {
                  value = parseInt(String(valueStr).replace(/[<\s]/g, ''), 10);
                }
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
                scheduleUpdate();
              }
            }
          }
        } else {
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
    
    
    // 查找参照词
    const reference = findReferenceTerm(apiData);
    
    // 渲染数据，使用特殊标记确保这是API数据（最后一个时间点）
    render(apiData, "估算搜索量（最后时间点）", reference);
  }
  
  // 处理待处理的响应（在parseApiResponse定义后调用）
  function processPendingResponses() {
    if (pendingResponses.length > 0) {
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
      
      // 获取所有网络请求
      const resources = performance.getEntriesByType('resource');
      
      // 查找最近的 multiline 请求
      let latestMultiline = null;
      let latestTime = 0;
      
      for (const resource of resources) {
        const resourceName = resource.name || '';
        // 减少日志输出，只检查 multiline 请求
        if (resourceName.includes('/trends/api/widgetdata/multiline')) {
          const requestTime = resource.responseEnd || resource.startTime || 0;
          if (requestTime > latestTime) {
            latestTime = requestTime;
            latestMultiline = resource;
          }
        }
      }
      
      if (latestMultiline) {
        const multilineUrl = latestMultiline.name;
        
        // 尝试从缓存中获取响应（避免重复请求）
        try {
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
                
                // 按时间戳排序
                const sorted = [...timelineData].sort((a, b) => {
                  const timeA = parseInt(a.time) || 0;
                  const timeB = parseInt(b.time) || 0;
                  return timeA - timeB;
                });
                
                // 打印最后一个数据点
                const lastPoint = sorted[sorted.length - 1];
                
                // 打印最后3个数据点
                const lastFew = sorted.slice(-3);
                lastFew.forEach((point, idx) => {
                  const actualIdx = sorted.length - 3 + idx;
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
        // 未找到 multiline 属正常（例如图表尚未加载、或数据来自 tooltip），仅调试时输出
        console.debug('[扩展] 未找到 multiline 请求，已检查', resources.length, '个请求');
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
      document.body.appendChild(el);
      
      // 使用延迟确保 DOM 已插入
      setTimeout(() => {
        el.innerHTML = `
          <div class="title">
            <span>估算搜索量</span>
            <div class="mode-switch">
              <button class="mode-btn ${displayMode === 'daily' ? 'active' : ''}" data-mode="daily">日</button>
              <button class="mode-btn ${displayMode === 'monthly' ? 'active' : ''}" data-mode="monthly">月</button>
            </div>
          </div>
          <div id="trends-volume-rows"></div>
          <div class="sub">
            <div class="sub-left">
              <span class="sub-desc">基于参照词动态折算</span>
            </div>
            <div class="sub-actions">
              <button class="ref-settings-btn" title="参考词与基准流量设置" aria-label="设置">⚙</button>
              <button class="copy-btn" title="复制数据到剪贴板">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="ref-settings-panel" id="ref-settings-panel" style="display:none;">
            <div class="ref-settings-title">参考词与基准流量</div>
            <div class="ref-settings-list" id="ref-settings-list"></div>
            <div class="ref-settings-add">
              <input type="text" id="ref-new-term" placeholder="词名" />
              <input type="number" id="ref-new-daily" placeholder="日流量" min="0" step="1" />
              <button type="button" class="ref-add-btn">添加</button>
            </div>
            <div class="ref-save-toast" id="ref-save-toast" aria-live="polite"></div>
            <div class="ref-settings-footer">
              <button type="button" class="ref-save-btn">保存</button>
              <button type="button" class="ref-close-btn">关闭</button>
            </div>
          </div>
        `;
        
        makeDraggable(el);

        // 使用事件委托：在 overlay 上统一处理点击，避免因加载顺序导致按钮无响应
        if (!el.hasAttribute('data-overlay-delegation-bound')) {
          el.setAttribute('data-overlay-delegation-bound', '1');
          el.addEventListener('click', overlayClickDelegation);
        }
        // 绑定切换开关事件（保留以兼容可能的外部调用，委托已覆盖）
        const modeButtons = el.querySelectorAll('.mode-btn');
        modeButtons.forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const mode = btn.dataset.mode;
            displayMode = mode;
            
            // 更新按钮状态
            modeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // 重新渲染
            if (currentHoverData && currentHoverData.values) {
              const reference = findReferenceTerm(currentHoverData.values);
              render(currentHoverData.values, `估算搜索量（${currentHoverData.date}）`, reference);
            } else if (Object.keys(apiData).length > 0) {
              const reference = findReferenceTerm(apiData);
              render(apiData, "估算搜索量（最后时间点）", reference);
            }
            
            // 重新处理原生 tooltip
            const tooltipSelectors = ['[role="tooltip"]', '[class*="tooltip"]'];
            for (const selector of tooltipSelectors) {
              const tooltips = document.querySelectorAll(selector);
              for (const tooltip of tooltips) {
                const text = tooltip.textContent || '';
                if (text.includes('年') && text.includes('月') && !text.includes('估算搜索量')) {
                  // 清除之前的增强标记，重新处理
                  tooltip.dataset.enhanced = 'false';
                  const existingSpans = tooltip.querySelectorAll('span[style*="margin-left"]');
                  existingSpans.forEach(span => {
                    if (span.textContent.includes('→')) {
                      span.remove();
                    }
                  });
                  // 重新提取并增强
                  extractDataFromTooltip();
                  break;
                }
              }
            }
          });
        });
      }, 0);
    } else {
      // 如果已存在，确保复制按钮已绑定事件
      const copyBtn = el.querySelector('.copy-btn');
      if (copyBtn && !copyBtn.hasAttribute('data-listener-bound')) {
        copyBtn.setAttribute('data-listener-bound', 'true');
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          copyDataToClipboard();
        });
      }

      // 如果已存在，确保事件委托已绑定（兜底：首次 ensureOverlay 时可能尚未执行 setTimeout）
      if (!el.hasAttribute('data-overlay-delegation-bound')) {
        el.setAttribute('data-overlay-delegation-bound', '1');
        el.addEventListener('click', overlayClickDelegation);
      }
      
      // 如果已存在，确保切换按钮已绑定事件
      const modeButtons = el.querySelectorAll('.mode-btn');
      if (modeButtons.length > 0 && !modeButtons[0].hasAttribute('data-listener-bound')) {
        modeButtons.forEach(btn => {
          btn.setAttribute('data-listener-bound', 'true');
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const mode = btn.dataset.mode;
            displayMode = mode;
            
            // 更新按钮状态
            modeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // 重新渲染
            if (currentHoverData && currentHoverData.values) {
              const reference = findReferenceTerm(currentHoverData.values);
              render(currentHoverData.values, `估算搜索量（${currentHoverData.date}）`, reference);
            } else if (Object.keys(apiData).length > 0) {
              const reference = findReferenceTerm(apiData);
              render(apiData, "估算搜索量（最后时间点）", reference);
            }
            
            // 重新处理原生 tooltip
            const tooltipSelectors = ['[role="tooltip"]', '[class*="tooltip"]'];
            for (const selector of tooltipSelectors) {
              const tooltips = document.querySelectorAll(selector);
              for (const tooltip of tooltips) {
                const text = tooltip.textContent || '';
                if (text.includes('年') && text.includes('月') && !text.includes('估算搜索量')) {
                  tooltip.dataset.enhanced = 'false';
                  const existingSpans = tooltip.querySelectorAll('span[style*="margin-left"]');
                  existingSpans.forEach(span => {
                    if (span.textContent.includes('→')) {
                      span.remove();
                    }
                  });
                  extractDataFromTooltip();
                  break;
                }
              }
            }
          });
        });
      }
    }
    return el;
  }

  function makeDraggable(el) {
    let isDown = false, startX = 0, startY = 0, sx = 0, sy = 0;

    el.addEventListener("mousedown", e => {
      // 若点击的是可交互区域，不启动拖拽，让点击事件正常触发
      if (e.target.closest('#trends-volume-rows')) return;
      if (e.target.closest('.sub')) return;           // ⚙、复制
      if (e.target.closest('.ref-settings-panel') || e.target.closest('#ref-settings-panel')) return;
      if (e.target.closest('.title')) return;         // 日/月 切换
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

        // 若任一参考词在平均值中存在，用其更新校准系数
        for (const [refKey, refInfo] of Object.entries(REFERENCE_TERMS)) {
          if (averages[refKey] != null && averages[refKey] > 0) {
            CAL_FACTOR = refInfo.daily / averages[refKey];
            const overlay = document.getElementById("trends-volume-overlay");
            if (overlay) {
              const subDesc = overlay.querySelector(".sub-desc");
              if (subDesc) {
                subDesc.textContent = `基于线性映射：指数 × ${CAL_FACTOR.toFixed(2)} (校准: ${refInfo.name} 平均 ${averages[refKey]} → ${refInfo.daily}次/日)`;
              }
            }
            break;
          }
        }
      }
    }

    return averages;
  }

  /** 渲染参考词设置列表到 #ref-settings-list */
  function renderRefSettingsList() {
    const listEl = document.getElementById('ref-settings-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    for (const [key, info] of Object.entries(REFERENCE_TERMS)) {
      const row = document.createElement('div');
      row.className = 'ref-settings-row';
      const canDelete = !isBuiltinReferenceTerm(key);
      row.innerHTML = `
        <span class="ref-term-name">${escapeHtml(info.name || key)}</span>
        <input type="number" class="ref-daily-input" data-key="${escapeHtml(key)}" value="${Number(info.daily)}" min="0" step="1" />
        ${canDelete ? '<button type="button" class="ref-del-btn" data-key="' + escapeHtml(key) + '">删除</button>' : '<span class="ref-builtin-hint">内置</span>'}
      `;
      listEl.appendChild(row);
      const delBtn = row.querySelector('.ref-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', function() {
          const k = this.getAttribute('data-key');
          if (k && !isBuiltinReferenceTerm(k)) {
            delete REFERENCE_TERMS[k];
            REFERENCE_TERMS = { ...REFERENCE_TERMS };
            renderRefSettingsList();
          }
        });
      }
    }
  }

  /** 从设置面板收集数据并保存到 storage，然后刷新 REFERENCE_TERMS */
  function saveRefSettingsFromPanel() {
    const listEl = document.getElementById('ref-settings-list');
    if (!listEl) return;
    const next = {};
    listEl.querySelectorAll('.ref-settings-row').forEach(row => {
      const key = row.querySelector('.ref-daily-input')?.getAttribute('data-key');
      const dailyInput = row.querySelector('.ref-daily-input');
      if (!key || !dailyInput) return;
      const daily = parseInt(dailyInput.value || '0', 10);
      if (isNaN(daily) || daily < 0) return;
      const name = row.querySelector('.ref-term-name')?.textContent?.trim() || key;
      next[key] = { daily, name };
    });
    if (Object.keys(next).length === 0) return;
    saveReferenceTermsToStorage(next, function() {
      scheduleUpdate();
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  /** 悬浮窗内点击事件委托（⚙、复制、关闭、保存、添加、日/月） */
  function overlayClickDelegation(e) {
    const overlay = document.getElementById('trends-volume-overlay');
    if (!overlay || !e.target || !e.target.closest) return;
    if (!overlay.contains(e.target)) return;
    if (e.target.closest('.ref-settings-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const panel = document.getElementById('ref-settings-panel');
      if (panel) {
        if (panel.style.display === 'none') {
          renderRefSettingsList();
          panel.style.display = 'block';
        } else {
          panel.style.display = 'none';
        }
      }
      return;
    }
    if (e.target.closest('.copy-btn')) {
      e.preventDefault();
      e.stopPropagation();
      copyDataToClipboard();
      return;
    }
    if (e.target.closest('.ref-close-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const panel = document.getElementById('ref-settings-panel');
      if (panel) panel.style.display = 'none';
      return;
    }
    if (e.target.closest('.ref-save-btn')) {
      e.preventDefault();
      e.stopPropagation();
      saveRefSettingsFromPanel();
      // 保存后立即用新参考词刷新 overlay 列表与底部说明（强制一次，不受节流影响）
      scheduleUpdate(true);
      const panel = document.getElementById('ref-settings-panel');
      const toast = document.getElementById('ref-save-toast');
      if (toast) {
        toast.textContent = '保存成功';
        toast.classList.add('ref-save-toast-visible');
      }
      setTimeout(function() {
        if (toast) toast.classList.remove('ref-save-toast-visible');
        if (panel) panel.style.display = 'none';
        scheduleUpdate();
      }, 1800);
      return;
    }
    if (e.target.closest('.ref-add-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const termInput = document.getElementById('ref-new-term');
      const dailyInput = document.getElementById('ref-new-daily');
      const term = (termInput?.value || '').trim().toLowerCase();
      const daily = parseInt(dailyInput?.value || '0', 10);
      if (term && !isNaN(daily) && daily >= 0) {
        REFERENCE_TERMS[term] = { daily, name: term };
        if (termInput) termInput.value = '';
        if (dailyInput) dailyInput.value = '';
        renderRefSettingsList();
      }
      return;
    }
    if (e.target.closest('.mode-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.target.closest('.mode-btn');
      const mode = btn?.dataset.mode;
      if (!mode) return;
      displayMode = mode;
      overlay.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.remove('active');
        if (b.dataset.mode === mode) b.classList.add('active');
      });
      if (currentHoverData && currentHoverData.values) {
        const reference = findReferenceTerm(currentHoverData.values);
        render(currentHoverData.values, `估算搜索量（${currentHoverData.date}）`, reference);
      } else if (Object.keys(apiData).length > 0) {
        const reference = findReferenceTerm(apiData);
        render(apiData, "估算搜索量（最后时间点）", reference);
      }
      const tooltipSelectors = ['[role="tooltip"]', '[class*="tooltip"]'];
      for (const selector of tooltipSelectors) {
        const tooltips = document.querySelectorAll(selector);
        for (const t of tooltips) {
          const text = t.textContent || '';
          if (text.includes('年') && text.includes('月') && !text.includes('估算搜索量')) {
            t.dataset.enhanced = 'false';
            const spans = t.querySelectorAll('span[style*="margin-left"]');
            spans.forEach(s => { if (s.textContent.includes('→')) s.remove(); });
            extractDataFromTooltip();
            break;
          }
        }
      }
    }
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

      // 根据显示模式只显示日或月
      let searchVolumeText = '';
      if (displayMode === 'daily' && dailySearchFormatted != null) {
        searchVolumeText = ` → ${dailySearchFormatted}/日`;
      } else if (displayMode === 'monthly' && monthlySearchFormatted != null) {
        searchVolumeText = ` → ${monthlySearchFormatted}/月`;
      }
      
      return `
        <div class="row">
          <div class="term">
            <span class="dot" style="background:${color}"></span>
            <span>${displayTerm}</span>
          </div>
          <div class="value">
            ${idx != null ? `${idx}` : "-"}${searchVolumeText}
          </div>
        </div>
      `;
    }).join("");

    rowsEl.innerHTML = html;

    if (titleNote) {
      const titleEl = overlay.querySelector(".title");
      if (titleEl) {
        // 只更新 title 中的文本部分，保留切换按钮
        const titleSpan = titleEl.querySelector("span");
        if (titleSpan) {
          titleSpan.textContent = titleNote;
        } else {
          // 如果没有 span，创建一个并插入到切换按钮之前
          const modeSwitch = titleEl.querySelector(".mode-switch");
          const span = document.createElement("span");
          span.textContent = titleNote;
          if (modeSwitch) {
            titleEl.insertBefore(span, modeSwitch);
          } else {
            titleEl.appendChild(span);
          }
        }
      }
    }
    
    // 只更新说明文字，保留 .sub 内的 ⚙ 与复制按钮
    const subDesc = overlay.querySelector(".sub-desc");
    if (subDesc) {
      if (reference) {
        const refDailyFormatted = formatToK(reference.dailySearch);
        subDesc.textContent = `基于参照词: ${reference.name} (${reference.chartValue} → ${refDailyFormatted}/日)`;
      } else {
        subDesc.textContent = `基于线性映射: 指数 × ${CAL_FACTOR.toFixed(2)}`;
      }
    }
  }

  // 9) 在原生 tooltip 中插入转换后的数值
  function enhanceNativeTooltipWithVolume(tooltipElement, termValues, dateStr) {
    try {
      // 清除之前的增强标记和转换值
      tooltipElement.dataset.enhanced = 'false';
      const existingSpans = tooltipElement.querySelectorAll('span[data-trends-volume="true"]');
      existingSpans.forEach(span => {
        span.remove();
      });
      
      // 检查 tooltip 是否仍然存在且可见
      const tooltipStyle = window.getComputedStyle(tooltipElement);
      if (tooltipStyle.display === 'none' || tooltipStyle.visibility === 'hidden') {
        return;
      }
      
      // 检查是否包含日期和数值（确保是有效的 tooltip）
      const tooltipText = tooltipElement.textContent || '';
      if (!tooltipText.match(/\d{4}年\d{1,2}月\d{1,2}日/) && !tooltipText.match(/\d{4}-\d{2}-\d{2}/)) {
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
      // 使用 Map 存储每个数值节点对应的转换值，避免重复计算
      const valueToConversionMap = new Map();
      
      textNodes.forEach((textNode, index) => {
        const value = parseInt(textNode.textContent.trim(), 10);
        if (isNaN(value) || value < 0 || value > 100) {
          return;
        }
        
        // 如果已经处理过这个值，直接使用缓存的转换文本
        if (valueToConversionMap.has(value)) {
          const conversionText = valueToConversionMap.get(value);
          // 检查是否已经添加了转换值
          const nextSibling = textNode.nextSibling;
          if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE && 
              nextSibling.textContent === conversionText) {
            return; // 已经添加过了
          }
          // 插入转换值
          const span = document.createElement('span');
          span.style.marginLeft = '4px';
          span.style.color = '#666';
          span.style.fontSize = '0.9em';
          span.style.whiteSpace = 'nowrap';
          span.style.display = 'inline';
          span.textContent = conversionText;
          if (textNode.parentNode) {
            textNode.parentNode.insertBefore(span, textNode.nextSibling);
          }
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
          
          // 根据显示模式只显示日或月
          let searchVolumeText = '';
          if (displayMode === 'daily') {
            const dailyFormatted = formatToK(dailySearch);
            searchVolumeText = ` → ${dailyFormatted}/日`;
          } else {
            const monthlyFormatted = formatToK(monthlySearch);
            searchVolumeText = ` → ${monthlyFormatted}/月`;
          }
          
          // 缓存转换文本
          valueToConversionMap.set(value, searchVolumeText);
          
          // 检查是否已经添加了转换值
          const nextSibling = textNode.nextSibling;
          if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE && 
              nextSibling.textContent === searchVolumeText) {
            return; // 已经添加过了
          }
          
          // 方法1：尝试直接修改文本节点内容（更激进，但可能被 Google Trends 覆盖）
          // 方法2：插入 span 元素（当前方法）
          // 优先使用方法2，因为它更稳定
          
          // 在数值后面插入转换后的值
          const span = document.createElement('span');
          span.style.marginLeft = '4px';
          span.style.color = '#666';
          span.style.fontSize = '0.9em';
          span.style.whiteSpace = 'nowrap';
          span.style.display = 'inline';
          span.textContent = searchVolumeText;
          
          // 添加唯一标识，方便后续查找
          span.dataset.trendsVolume = 'true';
          span.dataset.originalValue = value.toString();
          
          // 插入到数值节点后面
          if (textNode.parentNode) {
            // 直接插入到数值节点后面，保持原有布局
            textNode.parentNode.insertBefore(span, textNode.nextSibling);
          }
        }
      });
      
      // 使用 MutationObserver 持续监听 tooltip 变化，确保转换值不被移除
      if (!tooltipElement.dataset.observerAdded) {
        tooltipElement.dataset.observerAdded = 'true';
        let reapplyTimer = null;
        
        const tooltipObserver = new MutationObserver((mutations) => {
          // 检查是否有我们添加的 span 被移除，或者 tooltip 内容发生了变化
          const existingSpans = tooltipElement.querySelectorAll('span[data-trends-volume="true"]');
          const hasOurSpans = existingSpans.length > 0;
          
          // 检查是否有节点被移除（说明 Google Trends 重新渲染了 tooltip）
          const hasRemovedNodes = mutations.some(mutation => 
            mutation.removedNodes.length > 0 && 
            Array.from(mutation.removedNodes).some(node => 
              node.nodeType === Node.ELEMENT_NODE && 
              node.querySelector && 
              node.querySelector('span[style*="margin-left"]')
            )
          );
          
          // 如果我们的 span 被移除了，或者 tooltip 内容发生了变化，重新添加
          if ((!hasOurSpans || hasRemovedNodes) && Object.keys(termValues).length > 0) {
            // 使用防抖，避免频繁重新应用
            if (reapplyTimer) {
              clearTimeout(reapplyTimer);
            }
            reapplyTimer = setTimeout(() => {
              // 清除增强标记，强制重新处理
              tooltipElement.dataset.enhanced = 'false';
              // 移除所有残留的转换值 span
              const oldSpans = tooltipElement.querySelectorAll('span[style*="margin-left"]');
              oldSpans.forEach(span => {
                if (span.textContent.includes('→')) {
                  span.remove();
                }
              });
              // 使用 requestAnimationFrame 确保在渲染后立即应用
              requestAnimationFrame(() => {
                enhanceNativeTooltipWithVolume(tooltipElement, termValues, dateStr);
              });
            }, 50); // 延迟 50ms，更快响应
          }
        });
        
        tooltipObserver.observe(tooltipElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }
      
      // 调整 tooltip 宽度以适应内容，确保每个词一行不换行
      // 使用 requestAnimationFrame 确保在 DOM 更新后执行
      requestAnimationFrame(() => {
        try {
          // 查找所有我们添加的转换值 span
          const allValueSpans = tooltipElement.querySelectorAll('span[style*="margin-left"]');
          
          if (allValueSpans.length > 0) {
            // 找到每个数值+转换值的行容器（包含词名和数值的完整行）
            const rowContainers = new Set();
            allValueSpans.forEach(span => {
              // 向上查找，找到包含词名和数值的行容器
              // Google Trends 的 tooltip 结构通常是：每个词和数值在同一个块级容器中
              let container = span.parentNode;
              let depth = 0;
              while (container && container !== tooltipElement && depth < 10) {
                const style = window.getComputedStyle(container);
                const containerText = container.textContent || '';
                
                // 如果是块级元素，且包含词名（字母）和数值，说明是行容器
                if ((style.display === 'block' || style.display === 'flex') && 
                    containerText.match(/[A-Za-z]/) && 
                    containerText.match(/\d/)) {
                  rowContainers.add(container);
                  break;
                }
                container = container.parentNode;
                depth++;
              }
            });
            
            // 为每个行容器设置 nowrap，确保每个词一行不换行
            let maxRowWidth = 0;
            rowContainers.forEach(container => {
              // 确保行容器不换行
              container.style.whiteSpace = 'nowrap';
              container.style.display = 'block';
              
              // 临时设置为 nowrap 来测量实际宽度
              const originalWhiteSpace = container.style.whiteSpace;
              container.style.whiteSpace = 'nowrap';
              
              // 测量这一行的实际宽度（使用 scrollWidth 获取内容宽度）
              const width = container.scrollWidth || container.offsetWidth;
              if (width > maxRowWidth) {
                maxRowWidth = width;
              }
            });
            
            // 设置 tooltip 的宽度为最长行的宽度，确保所有行都不换行
            if (maxRowWidth > 0) {
              tooltipElement.style.width = 'auto';
              tooltipElement.style.minWidth = maxRowWidth + 40 + 'px'; // 增加 40px 边距
              tooltipElement.style.maxWidth = 'none';
              tooltipElement.style.whiteSpace = 'normal'; // tooltip 本身允许换行（行与行之间）
            }
          }
        } catch (e) {
          // 忽略样式设置错误
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

  // 复制数据到剪贴板
  function copyDataToClipboard() {
    try {
      // 获取当前显示的数据
      let values = {};
      let reference = null;
      
      // 优先使用悬停数据，否则使用API数据
      if (currentHoverData && currentHoverData.values) {
        values = currentHoverData.values;
        reference = findReferenceTerm(values);
      } else if (Object.keys(apiData).length > 0) {
        values = apiData;
        reference = findReferenceTerm(apiData);
      } else {
        console.warn('[扩展] 没有可复制的数据');
        return;
      }

      // 获取参考词列表（用于过滤）
      const referenceTerms = Object.keys(REFERENCE_TERMS).map(k => k.toLowerCase());
      
      // 构建复制数据
      const copyLines = [];
      
      for (const [term, idx] of Object.entries(values)) {
        const termLower = term.toLowerCase();
        
        // 过滤掉参考词
        let isReferenceTerm = false;
        for (const refTerm of referenceTerms) {
          if (termLower === refTerm || termLower.includes(refTerm) || refTerm.includes(termLower)) {
            isReferenceTerm = true;
            break;
          }
        }
        
        if (isReferenceTerm) {
          continue; // 跳过参考词
        }
        
        // 只处理有效的数值
        if (typeof idx !== "number" || idx < 0 || idx > 100) {
          continue;
        }
        
        // 计算搜索量（根据当前显示模式）
        let searchVolume = null;
        
        if (reference) {
          // 使用参照词计算（比例换算）
          const isRefTerm = termLower === reference.term || 
                           termLower.includes(reference.term) || 
                           reference.term.includes(termLower);
          
          if (!isRefTerm && reference.chartValue > 0) {
            // 其他词：根据与参照词的比例计算
            const dailySearch = reference.dailySearch * (idx / reference.chartValue);
            
            // 根据显示模式选择日或月搜索量
            if (displayMode === 'daily') {
              searchVolume = Math.round(dailySearch);
            } else {
              // 月搜索量 = 日搜索量 × 30
              searchVolume = Math.round(dailySearch * 30);
            }
          }
        } else {
          // 没有参照词，使用默认换算系数
          const dailySearch = idx * CAL_FACTOR;
          
          if (displayMode === 'daily') {
            searchVolume = Math.round(dailySearch);
          } else {
            searchVolume = Math.round(dailySearch * 30);
          }
        }
        
        // 只添加有效的搜索量
        if (searchVolume !== null && searchVolume > 0) {
          copyLines.push(`${term}\t${searchVolume}`);
        }
      }
      
      if (copyLines.length === 0) {
        console.warn('[扩展] 没有可复制的数据（所有词都是参考词或无效）');
        return;
      }
      
      // 格式化为制表符分隔的文本
      const copyText = copyLines.join('\n');
      
      // 复制到剪贴板
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(copyText).then(() => {
          // 显示复制成功提示
          const copyBtn = document.querySelector('.copy-btn');
          if (copyBtn) {
            const originalTitle = copyBtn.getAttribute('title') || '复制数据到剪贴板';
            copyBtn.setAttribute('title', '已复制！');
            setTimeout(() => {
              copyBtn.setAttribute('title', originalTitle);
            }, 2000);
          }
        }).catch(err => {
          console.warn('[扩展] 复制失败:', err);
          // 降级方案：使用传统方法
          fallbackCopyToClipboard(copyText);
        });
      } else {
        // 降级方案：使用传统方法
        fallbackCopyToClipboard(copyText);
      }
    } catch (e) {
      console.warn('[扩展] 复制数据时出错:', e);
    }
  }

  // 降级复制方案（兼容旧浏览器）
  function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        const copyBtn = document.querySelector('.copy-btn');
        if (copyBtn) {
          const originalTitle = copyBtn.getAttribute('title') || '复制数据到剪贴板';
          copyBtn.setAttribute('title', '已复制！');
          setTimeout(() => {
            copyBtn.setAttribute('title', originalTitle);
          }, 2000);
        }
      } else {
        console.warn('[扩展] 复制失败');
      }
    } catch (err) {
      console.warn('[扩展] 复制失败:', err);
    } finally {
      document.body.removeChild(textArea);
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
        reference = findReferenceTerm(currentHoverData.values);
        const title = `估算搜索量（${currentHoverData.date}）`;
        render(currentHoverData.values, title, reference);
      } else if (Object.keys(apiData).length > 0) {
        // 使用API数据（最后时间点）
        // 减少日志输出，避免刷屏
        reference = findReferenceTerm(apiData);
        render(apiData, "估算搜索量（最后时间点）", reference);
      } else {
        // 只在调试时输出日志，避免刷屏
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
  
  // 不再清除悬停数据，保持最后一次展示状态
  // document.addEventListener("mouseleave", (e) => {
  //   // 延迟清除，避免快速移动时频繁清除
  //   if (mouseLeaveTimer) {
  //     clearTimeout(mouseLeaveTimer);
  //   }
  //   mouseLeaveTimer = setTimeout(() => {
  //     if (currentHoverData !== null) {
  //       currentHoverData = null;
  //       scheduleUpdate();
  //     }
  //   }, 500); // 延迟 500ms，避免快速移动时误清除
  // }, { passive: true });

  function start() {
    ensureOverlay();
    updateTermColors();
    
    // 不再重复设置拦截器，因为已经在页面加载前设置了
    // interceptNetworkRequests();
    
    // 处理在parseApiResponse定义前拦截到的响应
    processPendingResponses();
    
    // 如果 API 数据为空，尝试从 Performance API 获取（延迟更长时间，等待请求完成）
    if (Object.keys(apiData).length === 0) {
      setTimeout(() => {
        if (Object.keys(apiData).length === 0) {
          fetchLatestMultilineFromPerformance();
        } else {
        }
      }, 3000); // 延迟3秒，等待 multiline 请求完成
    } else {
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

  // 先从 storage 加载参考词配置，再启动
  function boot() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
  loadReferenceTermsFromStorage(boot);

  // 页面可见性变化时重新检测
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleUpdate();
    }
  });

})();

