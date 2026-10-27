// 连续分组，取最小的最大列高；不会把谱句按奇偶行分开。
export function partitionRows(heights, columns) {
  columns = Math.min(columns, heights.length);
  if (!columns) return { ends: [], height: 0 };
  let low = Math.max(...heights);
  let high = heights.reduce((sum, height) => sum + height, 0);
  while (low < high) {
    const limit = Math.floor((low + high) / 2);
    let used = 1;
    let height = 0;
    for (const row of heights) {
      if (height + row > limit) {
        used++;
        height = 0;
      }
      height += row;
    }
    if (used <= columns) high = limit;
    else low = limit + 1;
  }
  const ends = [heights.length];
  let height = 0;
  for (let index = heights.length - 1; index >= 0; index--) {
    if (height + heights[index] > low || index + 1 < columns) {
      ends.unshift(index + 1);
      columns--;
      height = 0;
    }
    height += heights[index];
  }
  return { ends, height: low };
}

// 保留同一套谱句/音符节点，只在一屏总览时重排、缩放；播放不触发布局。
export class PracticeOverview {
  constructor(root, onLayout) {
    this.root = root;
    this.onLayout = onLayout;
    this.enabled = false;
    this.frame = 0;
    this.schedule = () => {
      if (!this.enabled || this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.fit();
      });
    };
    new ResizeObserver(this.schedule).observe(root);
    document.fonts.ready.then(this.schedule);
    document.fonts.addEventListener("loadingdone", this.schedule);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.schedule();
      return;
    }
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const page = this.root.querySelector(".overview-page");
    if (page) {
      const rows = [...page.querySelectorAll(".phrase")];
      rows.forEach((row) => row.style.removeProperty("min-height"));
      this.root.replaceChildren(...rows);
    }
    delete this.root.dataset.overviewColumns;
    delete this.root.dataset.overviewScale;
    this.onLayout(null);
  }

  measure(rows, page, width, scale, columns) {
    const gap = 24;
    page.style.width = `${(width / scale - gap * (columns - 1)) / columns}px`;
    const heights = rows.map((row) => row.offsetHeight);
    return { columns, scale, heights, ...partitionRows(heights, columns) };
  }

  bestLayout(rows, page, width, height, columns) {
    let result = this.measure(rows, page, width, 1, columns);
    if (result.height <= height) return result;
    let low = Math.min(0.5, height / (result.height + height));
    result = this.measure(rows, page, width, low, columns);
    let high = 1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const scale = (low + high) / 2;
      const candidate = this.measure(rows, page, width, scale, columns);
      if (candidate.height * scale <= height) {
        low = scale;
        result = candidate;
      } else high = scale;
    }
    return result;
  }

  fit() {
    if (!this.enabled) return;
    const width = this.root.clientWidth - 12;
    const height = this.root.clientHeight - 12;
    if (width <= 0 || height <= 0) return;
    const rows = [...this.root.querySelectorAll(".phrase")];
    if (!rows.length) return;
    rows.forEach((row) => row.style.removeProperty("min-height"));
    const page = document.createElement("div");
    page.className = "overview-page measuring";
    page.append(...rows);
    this.root.replaceChildren(page);
    let best = this.bestLayout(rows, page, width, height, 1);
    const maxColumns = Math.min(
      rows.length,
      width < 600 ? 2 : width < 1000 ? 3 : 4,
    );
    for (let columns = 2; columns <= maxColumns && best.scale < 1; columns++) {
      const candidate = this.bestLayout(rows, page, width, height, columns);
      if (candidate.scale > best.scale * 1.03) best = candidate;
    }
    // 固定此次测量的行高，歌词按遍切换/当前行变亮时不挤动整张谱。
    rows.forEach(
      (row, index) => (row.style.minHeight = `${best.heights[index]}px`),
    );
    let start = 0;
    const columns = best.ends.map((end) => {
      const column = document.createElement("div");
      column.className = "overview-column";
      column.append(...rows.slice(start, end));
      start = end;
      return column;
    });
    page.replaceChildren(...columns);
    page.classList.remove("measuring");
    page.style.width = `${width / best.scale}px`;
    page.style.gridTemplateColumns = `repeat(${best.columns}, minmax(0, 1fr))`;
    page.style.transform = `scale(${best.scale})`;
    this.root.scrollTop = 0;
    this.root.scrollLeft = 0;
    this.root.dataset.overviewColumns = best.columns;
    this.root.dataset.overviewScale = best.scale;
    this.onLayout(best);
  }
}
