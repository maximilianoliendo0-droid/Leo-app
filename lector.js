
/* ==========================================
   LEO APP - LECTOR OCR UNIVERSAL
   Compatible con index.html actual
   ========================================== */

window.LeoReader = (function () {
  "use strict";

  const MONTHS = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11
  };

  function clean(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function report(progress, value, text) {
    if (typeof progress === "function") {
      progress(value, text);
    }
  }

  // ------------------------------------------
  // CARGA Y RECORTE DE IMAGEN
  // ------------------------------------------

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);

      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };

      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("No se pudo abrir la imagen."));
      };

      image.src = url;
    });
  }

  function cropBlackMargins(image) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    ctx.drawImage(image, 0, 0);

    const data = ctx.getImageData(
      0, 0, canvas.width, canvas.height
    ).data;

    const width = canvas.width;
    const height = canvas.height;

    const rowHasContent = y => {
      let count = 0;

      for (let x = 0; x < width; x += 3) {
        const i = (y * width + x) * 4;

        const brightness =
          (data[i] + data[i + 1] + data[i + 2]) / 3;

        if (brightness > 35) count++;
      }

      return count / Math.ceil(width / 3) > 0.025;
    };

    const colHasContent = x => {
      let count = 0;

      for (let y = 0; y < height; y += 3) {
        const i = (y * width + x) * 4;

        const brightness =
          (data[i] + data[i + 1] + data[i + 2]) / 3;

        if (brightness > 35) count++;
      }

      return count / Math.ceil(height / 3) > 0.025;
    };

    let top = 0;
    let bottom = height - 1;
    let left = 0;
    let right = width - 1;

    while (top < bottom && !rowHasContent(top)) top++;
    while (bottom > top && !rowHasContent(bottom)) bottom--;

    while (left < right && !colHasContent(left)) left++;
    while (right > left && !colHasContent(right)) right--;

    const margin = 5;

    top = Math.max(0, top - margin);
    left = Math.max(0, left - margin);
    bottom = Math.min(height - 1, bottom + margin);
    right = Math.min(width - 1, right + margin);

    const output = document.createElement("canvas");

    output.width = right - left + 1;
    output.height = bottom - top + 1;

    output.getContext("2d").drawImage(
      image,
      left, top,
      output.width, output.height,
      0, 0,
      output.width, output.height
    );

    return output;
  }

  // ------------------------------------------
  // MEJORAR CONTRASTE SIN DEPENDER DEL COLOR
  // ------------------------------------------

  function prepareOCR(canvas) {
    const scale = Math.min(
      3,
      Math.max(1, 1800 / canvas.width)
    );

    const output = document.createElement("canvas");

    output.width = Math.round(canvas.width * scale);
    output.height = Math.round(canvas.height * scale);

    const ctx = output.getContext("2d", {
      willReadFrequently: true
    });

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, output.width, output.height);

    ctx.drawImage(
      canvas,
      0, 0, canvas.width, canvas.height,
      0, 0, output.width, output.height
    );

    const imageData = ctx.getImageData(
      0, 0, output.width, output.height
    );

    const pixels = imageData.data;

    for (let i = 0; i < pixels.length; i += 4) {
      const gray =
        0.299 * pixels[i] +
        0.587 * pixels[i + 1] +
        0.114 * pixels[i + 2];

      // Mantener información de texto sin depender del color.
      const enhanced = Math.max(
        0,
        Math.min(255, (gray - 125) * 1.45 + 128)
      );

      pixels[i] = enhanced;
      pixels[i + 1] = enhanced;
      pixels[i + 2] = enhanced;
    }

    ctx.putImageData(imageData, 0, 0);

    return output;
  }

  // ------------------------------------------
  // OCR
  // ------------------------------------------

  async function recognize(canvas, progress) {
    if (!window.Tesseract) {
      throw new Error("No se cargó Tesseract OCR.");
    }

    const worker = await Tesseract.createWorker("spa");

    try {
      await worker.setParameters({
        preserve_interword_spaces: "1"
      });

      const result = await worker.recognize(canvas, {}, {
        text: true,
        blocks: true,
        hocr: false,
        tsv: false
      });

      report(progress, 75, "Texto reconocido.");

      return result.data;

    } finally {
      await worker.terminate();
    }
  }

  // ------------------------------------------
  // OBTENER PALABRAS Y COORDENADAS
  // ------------------------------------------

  function getWords(data) {
    return (data.words || [])
      .filter(w => w.text && w.bbox)
      .map(w => ({
        text: clean(w.text),
        x: (w.bbox.x0 + w.bbox.x1) / 2,
        y: (w.bbox.y0 + w.bbox.y1) / 2,
        x0: w.bbox.x0,
        x1: w.bbox.x1,
        y0: w.bbox.y0,
        y1: w.bbox.y1,
        confidence: w.confidence || 0
      }));
  }

  // ------------------------------------------
  // AGRUPAR TEXTO POR FILAS
  // ------------------------------------------

  function clusterRows(words) {
    const sorted = words.slice().sort((a, b) => a.y - b.y);
    const rows = [];

    sorted.forEach(word => {
      let best = null;
      let distance = Infinity;

      rows.forEach(row => {
        const d = Math.abs(row.y - word.y);
        const tolerance = Math.max(
          8,
          (word.y1 - word.y0) * 0.65
        );

        if (d < tolerance && d < distance) {
          best = row;
          distance = d;
        }
      });

      if (!best) {
        best = { y: word.y, words: [] };
        rows.push(best);
      }

      best.words.push(word);

      best.y = best.words.reduce(
        (sum, w) => sum + w.y, 0
      ) / best.words.length;
    });

    rows.forEach(row => {
      row.words.sort((a, b) => a.x - b.x);
    });

    return rows.sort((a, b) => a.y - b.y);
  }

  // ------------------------------------------
  // EXTRAER NÚMEROS DE DÍAS
  // ------------------------------------------

  function extractNumbers(text) {
    const value = clean(text)
      .replace(/[Oo]/g, "0")
      .replace(/[Il|]/g, "1");

    const matches = value.match(/\d{1,2}/g) || [];

    return matches
      .map(Number)
      .filter(n => n >= 1 && n <= 31);
  }

  function findDateRow(rows) {
    let best = null;
    let bestScore = 0;

    rows.forEach((row, index) => {
      const found = [];

      row.words.forEach(word => {
        const numbers = extractNumbers(word.text);

        numbers.forEach(day => {
          found.push({
            day,
            x: word.x,
            confidence: word.confidence
          });
        });
      });

      // Evitar que números repetidos de horarios
      // se consideren una fila de fechas.
      const unique = [];

      found.sort((a, b) => a.x - b.x);

      found.forEach(item => {
        const duplicate = unique.some(
          u => Math.abs(u.x - item.x) < 12
        );

        if (!duplicate) unique.push(item);
      });

      const score = unique.length;

      if (score >= 3 && score > bestScore) {
        bestScore = score;
        best = {
          index,
          row,
          words: unique
        };
      }
    });

    return best;
  }

  // ------------------------------------------
  // DETECTAR MESES
  // ------------------------------------------

  function findMonths(rows, dateRow) {
    const result = [];

    rows.forEach(row => {
      // Los meses suelen aparecer por encima
      // de la fila numérica.
      if (row.y > dateRow.row.y) return;

      row.words.forEach(word => {
        const value = clean(word.text).toLowerCase();

        for (const name of Object.keys(MONTHS)) {
          if (value.includes(name)) {
            const yearMatch = value.match(/20\d{2}/);

            result.push({
              month: MONTHS[name],
              year: yearMatch ? Number(yearMatch[0]) : null,
              x: word.x
            });
          }
        }
      });
    });

    return result.sort((a, b) => a.x - b.x);
  }

  // ------------------------------------------
  // ASOCIAR DÍAS CON MESES Y AÑOS
  // ------------------------------------------

  function buildDates(dateRow, months) {
    const dateWords = dateRow.words
      .slice()
      .sort((a, b) => a.x - b.x);

    const result = [];

    let currentMonth = null;
    let currentYear = null;
    let previousDay = null;

    const currentDate = new Date();

    dateWords.forEach(word => {
      let nearest = null;
      let distance = Infinity;

      months.forEach(month => {
        const d = Math.abs(month.x - word.x);

        if (d < distance) {
          distance = d;
          nearest = month;
        }
      });

      // Si hay meses detectados, se usa la posición
      // del encabezado para elegir el mes.
      if (nearest && distance < 500) {
        currentMonth = nearest.month;

        if (nearest.year) {
          currentYear = nearest.year;
        }
      }

      const day = word.day;

      if (currentMonth === null) {
        currentMonth = currentDate.getMonth();
      }

      if (currentYear === null) {
        currentYear = currentDate.getFullYear();
      }

      if (
        previousDay !== null &&
        day < previousDay &&
        day <= 5 &&
        previousDay >= 25
      ) {
        currentMonth++;

        if (currentMonth > 11) {
          currentMonth = 0;
          currentYear++;
        }
      }

      result.push({
        day,
        month: currentMonth,
        year: currentYear,
        x: word.x
      });

      previousDay = day;
    });

    return result;
  }

  // ------------------------------------------
  // RECONOCER HORARIOS
  // ------------------------------------------

  function parseHours(text) {
    const value = clean(text)
      .toLowerCase()
      .replace(/hs?/g, "")
      .replace(/[–—]/g, "-")
      .replace(/\s/g, "");

    const match = value.match(
      /(?:^|[^0-9])([0-2]?\d)-([0-2]?\d)(?:$|[^0-9])/
    );

    if (!match) return null;

    const start = Number(match[1]);
    const end = Number(match[2]);

    if (start > 23 || end > 23) return null;

    return {
      hours: start + "-" + end,
      status: "pendiente"
    };
  }

  // ------------------------------------------
  // NOMBRES Y CELDAS
  // ------------------------------------------

  function getPeople(rows, dateRow, dates) {
    if (!dates.length) return [];

    const firstDateX = dates[0].x;

    const spacing = dates.length > 1
      ? Math.abs(dates[1].x - dates[0].x)
      : 80;

    const nameLimit = firstDateX - spacing * 0.35;

    const people = [];

    rows.forEach(row => {
      if (row.y <= dateRow.row.y) return;

      const nameWords = row.words.filter(
        w => w.x < nameLimit
      );

      if (!nameWords.length) return;

      const name = clean(
        nameWords.map(w => w.text).join(" ")
      );

      if (name.length < 4) return;

      if (!/[a-záéíóúñ]/i.test(name)) return;

      if (
        /feriado|vacaciones|nuevos equipos|nombre|personal/i.test(name)
      ) return;

      people.push({
        name,
        row
      });
    });

    return people;
  }

  function getCellWords(row, dates, index) {
    const current = dates[index];
    const previous = dates[index - 1];
    const next = dates[index + 1];

    const left = previous
      ? (previous.x + current.x) / 2
      : current.x - 100;

    const right = next
      ? (current.x + next.x) / 2
      : current.x + 100;

    return row.words.filter(w =>
      w.x >= left && w.x < right
    );
  }

  // ------------------------------------------
  // ARMAR RESULTADOS
  // ------------------------------------------

  function makeDate(date) {
    return date.year + "-" +
      String(date.month + 1).padStart(2, "0") + "-" +
      String(date.day).padStart(2, "0");
  }

  function extractCandidates(rows, dateRow, dates) {
    const people = getPeople(rows, dateRow, dates);
    const candidates = [];

    people.forEach(person => {
      dates.forEach((date, index) => {
        const words = getCellWords(
          person.row,
          dates,
          index
        );

        if (!words.length) return;

        const raw = words
          .map(w => w.text)
          .join(" ");

        const parsed = parseHours(raw);

        if (!parsed) return;

        const confidence = Math.round(
          words.reduce((sum, w) => sum + w.confidence, 0) /
          words.length
        );

        candidates.push({
          person: person.name,
          date: makeDate(date),
          day: date.day,
          month: date.month + 1,
          year: date.year,
          raw,
          hours: parsed.hours,
          confidence,
          status: "pendiente"
        });
      });
    });

    return candidates;
  }

  // ------------------------------------------
  // FUNCIÓN PRINCIPAL
  // ------------------------------------------

  async function scan(file, progress) {
    report(progress, 0, "Preparando imagen...");

    const image = await loadImage(file);

    report(progress, 10, "Recortando márgenes...");

    const cropped = cropBlackMargins(image);

    report(progress, 20, "Mejorando imagen...");

    const prepared = prepareOCR(cropped);

    report(progress, 30, "Reconociendo texto...");

    const data = await recognize(prepared, progress);

    report(progress, 80, "Analizando filas y fechas...");

    const words = getWords(data);
    const rows = clusterRows(words);

    if (!rows.length) {
      throw new Error(
        "No se pudo reconocer texto. Probá con otra imagen."
      );
    }

    const dateRow = findDateRow(rows);

    if (!dateRow) {
      throw new Error(
        "No se pudieron identificar los números de los días. El OCR no encontró una fila de fechas suficiente."
      );
    }

    report(progress, 85, "Identificando meses...");

    const months = findMonths(rows, dateRow);
    const dates = buildDates(dateRow, months);

    if (!dates.length) {
      throw new Error("No se pudieron interpretar las fechas.");
    }

    report(progress, 92, "Buscando trabajadores y horarios...");

    const candidates = extractCandidates(
      rows,
      dateRow,
      dates
    );

    report(
      progress,
      100,
      "Lectura finalizada: " +
      candidates.length +
      " horarios encontrados."
    );

    return {
      candidates,
      dates,
      months,
      text: data.text || ""
    };
  }

  return {
    scan,
    parseHours
  };

})();
