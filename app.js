const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PAGE_WIDTH_DEFAULT_MM = 100;
const OUTLINE_COLOR = [255, 0, 255];

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const results = document.getElementById("results");
const statusText = document.getElementById("statusText");
const summary = document.getElementById("summary");
const pageWidthInput = document.getElementById("pageWidth");
const autoDownloadInput = document.getElementById("autoDownload");
const backgroundColorInput = document.getElementById("backgroundColor");
const backgroundModeInput = document.getElementById("backgroundMode");

const state = {
  entries: [],
};

fileInput.addEventListener("change", async () => {
  await ingestFiles(fileInput.files);
  fileInput.value = "";
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragover");
});

dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragover");
  await ingestFiles(event.dataTransfer.files);
});

function setStatus(message) {
  statusText.textContent = message;
}

function updateSummary() {
  const count = state.entries.length;
  summary.innerHTML = "";

  if (!count) {
    summary.append(createChip("No files processed yet"));
    return;
  }

  const ready = state.entries.filter((entry) => entry.pdfUrl).length;
  summary.append(
    createChip(`${count} file${count === 1 ? "" : "s"}`),
    createChip(`${ready} PDF${ready === 1 ? "" : "s"} ready`),
  );
}

function createChip(label) {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = label;
  return chip;
}

async function ingestFiles(fileList) {
  const files = [...fileList].filter((file) => SUPPORTED_TYPES.has(file.type));

  if (!files.length) {
    setStatus("Select at least one PNG, JPG, or WebP image.");
    return;
  }

  setStatus(`Processing ${files.length} file${files.length === 1 ? "" : "s"}...`);
  results.replaceChildren();

  const pageWidthMm = getPageWidthMm();
  const backgroundColor = backgroundModeInput.value === "color" ? backgroundColorInput.value : null;
  state.entries = [];

  for (const file of files) {
    const entry = await processFile(file, pageWidthMm, backgroundColor);
    state.entries.push(entry);
    results.append(renderEntry(entry));
    updateSummary();
    setStatus(`Processed ${state.entries.length} of ${files.length} file${files.length === 1 ? "" : "s"}.`);

    if (autoDownloadInput.checked) {
      triggerDownload(entry.pdfUrl, entry.pdfName);
    }
  }

  setStatus(`Ready. Generated ${state.entries.length} PDF${state.entries.length === 1 ? "" : "s"}.`);
  updateSummary();
}

function getPageWidthMm() {
  const value = Number(pageWidthInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    return PAGE_WIDTH_DEFAULT_MM;
  }

  return value;
}

async function processFile(file, pageWidthMm, backgroundColor) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const mask = buildAlphaMask(imageData);
  const component = extractLargestComponent(mask, canvas.width, canvas.height);
  const outline = simplifyPolygon(buildBoundaryPolygon(component.mask, canvas.width, canvas.height));

  const pageHeightMm = (canvas.height / canvas.width) * pageWidthMm;
  const pdf = new window.jspdf.jsPDF({
    orientation: pageWidthMm >= pageHeightMm ? "landscape" : "portrait",
    unit: "mm",
    format: [pageWidthMm, pageHeightMm],
    compress: true,
  });

  // Add background if specified
  if (backgroundColor) {
    const rgb = hexToRgb(backgroundColor);
    pdf.setFillColor(rgb.r, rgb.g, rgb.b);
    pdf.rect(0, 0, pageWidthMm, pageHeightMm, "F");
  }

  const imageDataUrl = canvas.toDataURL("image/png");
  pdf.addImage(imageDataUrl, "PNG", 0, 0, pageWidthMm, pageHeightMm, undefined, "FAST");

  if (outline.length > 1) {
    pdf.setDrawColor(...OUTLINE_COLOR);
    pdf.setLineWidth(0.2);
    pdf.setLineJoin("round");

    const scaleX = pageWidthMm / canvas.width;
    const scaleY = pageHeightMm / canvas.height;
    for (let i = 0; i < outline.length; i += 1) {
      const current = outline[i];
      const next = outline[(i + 1) % outline.length];
      pdf.line(current.x * scaleX, current.y * scaleY, next.x * scaleX, next.y * scaleY);
    }
  }

  const pdfName = `print_ready_${stripExtension(file.name)}.pdf`;
  const pdfUrl = URL.createObjectURL(pdf.output("blob"));

  return {
    name: file.name,
    pdfName,
    pdfUrl,
    previewUrl: imageDataUrl,
    width: canvas.width,
    height: canvas.height,
    points: outline.length,
    componentPixels: component.size,
    outline,
  };
}

function buildAlphaMask(imageData) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);

  for (let index = 0, pixel = 0; pixel < mask.length; pixel += 1, index += 4) {
    mask[pixel] = data[index + 3] > 0 ? 1 : 0;
  }

  return mask;
}

function extractLargestComponent(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const offsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  let best = null;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) {
      continue;
    }

    const queue = [start];
    visited[start] = 1;
    const pixels = [];

    while (queue.length) {
      const current = queue.pop();
      pixels.push(current);

      const x = current % width;
      const y = Math.floor(current / width);

      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;

        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }

        const neighbor = ny * width + nx;
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }

    if (!best || pixels.length > best.size) {
      best = { pixels, size: pixels.length };
    }
  }

  if (!best) {
    throw new Error("No visible pixels found in alpha channel.");
  }

  const componentMask = new Uint8Array(mask.length);
  for (const pixel of best.pixels) {
    componentMask[pixel] = 1;
  }

  return { mask: componentMask, size: best.size };
}

function buildBoundaryPolygon(mask, width, height) {
  const edges = new Map();

  const addEdge = (x1, y1, x2, y2) => {
    addNeighbor(edges, keyForPoint(x1, y1), { x: x2, y: y2 });
    addNeighbor(edges, keyForPoint(x2, y2), { x: x1, y: y1 });
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) {
        continue;
      }

      if (y === 0 || !mask[index - width]) {
        addEdge(x, y, x + 1, y);
      }

      if (x === width - 1 || !mask[index + 1]) {
        addEdge(x + 1, y, x + 1, y + 1);
      }

      if (y === height - 1 || !mask[index + width]) {
        addEdge(x + 1, y + 1, x, y + 1);
      }

      if (x === 0 || !mask[index - 1]) {
        addEdge(x, y + 1, x, y);
      }
    }
  }

  const loops = [];
  const usedEdges = new Set();

  for (const [startKey, neighbors] of edges.entries()) {
    for (const neighbor of neighbors) {
      const edgeKey = edgeId(startKey, keyForPoint(neighbor.x, neighbor.y));
      if (usedEdges.has(edgeKey)) {
        continue;
      }

      const loop = walkLoop(edges, startKey, neighbor, usedEdges);
      if (loop.length > 2) {
        loops.push(loop);
      }
    }
  }

  if (!loops.length) {
    throw new Error("Could not trace an outline from the alpha mask.");
  }

  return loops.reduce((largest, current) => {
    if (!largest || polygonArea(current) > polygonArea(largest)) {
      return current;
    }
    return largest;
  });
}

function walkLoop(edges, startKey, initialNeighbor, usedEdges) {
  const loop = [pointFromKey(startKey)];
  let previousKey = startKey;
  let currentPoint = initialNeighbor;
  let currentKey = keyForPoint(currentPoint.x, currentPoint.y);

  while (true) {
    usedEdges.add(edgeId(previousKey, currentKey));
    loop.push({ x: currentPoint.x, y: currentPoint.y });

    const neighbors = edges.get(currentKey) || [];
    const nextPoint = neighbors.find((neighbor) => {
      const neighborKey = keyForPoint(neighbor.x, neighbor.y);
      return neighborKey !== previousKey && !usedEdges.has(edgeId(currentKey, neighborKey));
    });

    if (!nextPoint) {
      break;
    }

    previousKey = currentKey;
    currentPoint = nextPoint;
    currentKey = keyForPoint(currentPoint.x, currentPoint.y);

    if (currentKey === startKey) {
      usedEdges.add(edgeId(previousKey, currentKey));
      break;
    }
  }

  return loop;
}

function simplifyPolygon(points) {
  if (points.length < 4) {
    return points;
  }

  const epsilon = Math.max(1, 0.002 * polygonPerimeter(points));
  const closed = points.slice();
  closed.push(points[0]);
  return rdp(closed, epsilon);
}

function rdp(points, epsilon) {
  if (points.length < 3) {
    return points;
  }

  let index = -1;
  let maxDistance = 0;

  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }

  if (maxDistance > epsilon && index !== -1) {
    const left = rdp(points.slice(0, index + 1), epsilon);
    const right = rdp(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }

  return [points[0], points[points.length - 1]];
}

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const numerator = Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x);
  return numerator / Math.hypot(dx, dy);
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum / 2);
}

function polygonPerimeter(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return sum;
}

function renderEntry(entry) {
  const card = document.createElement("article");
  card.className = "panel result-card";

  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = entry.name;
  const subtitle = document.createElement("span");
  subtitle.className = "meta";
  subtitle.textContent = `${entry.width} × ${entry.height}px`;
  header.append(title, subtitle);

  const preview = document.createElement("img");
  preview.className = "preview";
  preview.src = entry.previewUrl;
  preview.alt = entry.name;

  const outlineCanvas = document.createElement("canvas");
  outlineCanvas.className = "outline-preview";
  outlineCanvas.width = 640;
  outlineCanvas.height = Math.max(320, Math.round((entry.height / entry.width) * 640));
  drawOutlinePreview(outlineCanvas, entry);

  const meta = document.createElement("p");
  meta.className = "result-meta";
  meta.textContent = `${entry.points} outline points, ${entry.componentPixels} opaque pixels, PDF ${entry.pdfName}`;

  const actions = document.createElement("div");
  actions.className = "result-actions";

  const download = document.createElement("a");
  download.className = "button primary";
  download.href = entry.pdfUrl;
  download.download = entry.pdfName;
  download.textContent = "Download PDF";

  const open = document.createElement("a");
  open.className = "button";
  open.href = entry.pdfUrl;
  open.target = "_blank";
  open.rel = "noreferrer";
  open.textContent = "Open PDF";

  actions.append(download, open);
  card.append(header, preview, outlineCanvas, meta, actions);
  return card;
}

function drawOutlinePreview(canvas, entry) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fffaf3";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const scale = Math.min((canvas.width - 24) / entry.width, (canvas.height - 24) / entry.height);
  const offsetX = (canvas.width - entry.width * scale) / 2;
  const offsetY = (canvas.height - entry.height * scale) / 2;

  const image = new Image();
  image.onload = () => {
    context.drawImage(image, offsetX, offsetY, entry.width * scale, entry.height * scale);
    context.strokeStyle = "rgba(255, 0, 255, 0.95)";
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.beginPath();
    const outline = entry.outline || [];
    if (outline.length) {
      context.moveTo(offsetX + outline[0].x * scale, offsetY + outline[0].y * scale);
      for (let i = 1; i < outline.length; i += 1) {
        context.lineTo(offsetX + outline[i].x * scale, offsetY + outline[i].y * scale);
      }
      context.closePath();
      context.stroke();
    }
  };
  image.src = entry.previewUrl;
}

function triggerDownload(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

function keyForPoint(x, y) {
  return `${x},${y}`;
}

function pointFromKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function addNeighbor(map, key, point) {
  const neighbors = map.get(key);
  if (neighbors) {
    neighbors.push(point);
    return;
  }

  map.set(key, [point]);
}

function edgeId(startKey, endKey) {
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
}

updateSummary();
