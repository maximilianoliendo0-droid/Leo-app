
/* ==========================================
   LEO APP - LECTOR OCR MEJORADO
   Una fila por pasajero / una columna por día
   ========================================== */

window.LeoReader = (function () {
  "use strict";

  const MONTHS = {
    enero: 0, febrero: 1, marzo: 2, abril: 3,
    mayo: 4, junio: 5, julio: 6, agosto: 7,
    septiembre: 8, setiembre: 8,
    octubre: 9, noviembre: 10, diciembre: 11
  };

  function clean(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function report(progress, value, message) {
    if (typeof progress === "function") {
      progress(value, message);
    }
  }

  // ------------------------------------------
  // ABRIR IMAGEN
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

  // ------------------------------------------
  // PREPARAR IMAGEN
  // ------------------------------------------

  function prepareOCR(image) {
    const scale = Math.min(
      3,
      Math.max(1.5, 2400 / image.width)
    );

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(
      image,
      0, 0, image.width, image.height,
      0, 0, canvas.width, canvas.height
    );

    const data = ctx.getImageData(
      0, 0, canvas.width, canvas.height
    );

    const pixels = data.data;

    for (let i = 0; i < pixels.length; i += 4) {
      const gray =
        pixels[i] * 0.299 +
        pixels[i + 1] * 0.587 +
        pixels[i + 2] * 0.114;

      const value = Math.max(
        0,
        Math.min(255, (gray - 125) * 1.5 + 128)
      );

      pixels[i] = value;
      pixels[i + 1] = value;
      pixels[i + 2] = value;
    }

    ctx.putImageData(data, 0, 0);
    return canvas;
  }

  // ------------------------------------------
  // RECONOCIMIENTO OCR
  // ------------------------------------------

  async function recognize(canvas, progress) {
    if (!window.Tesseract) {
      throw new Error("No se cargó Tesseract OCR.");
    }

    const worker = await Tesseract.createWorker("spa");

    try {
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT
      });

      const result = await worker.recognize(canvas);

      report(progress, 75, "Texto reconocido.");

      return result.data;
    } finally {
      await worker.terminate();
    }
  }

  // ------------------------------------------
  // OBTENER PALABRAS Y POSICIONES
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
        height: Math.max(1, w.bbox.y1 - w.bbox.y0),
        confidence: w.confidence || 0
      }));
  }

  // ------------------------------------------
  // AGRUPAR PALABRAS EN FILAS
  // ------------------------------------------

  function clusterRows(words) {
    const sorted = words.slice().sort((a, b) => {
      return a.y - b.y || a.x - b.x;
    });

    const rows = [];

    sorted.forEach(word => {
      let selected = null;
      let bestDistance = Infinity;

      rows.forEach(row => {
        const tolerance = Math.max(
          10,
          Math.min(24, word.height * 0.8)
        );

        const distance = Math.abs(row.y - word.y);

        if (
          distance <= tolerance &&
          distance < bestDistance
        ) {
          selected = row;
          bestDistance = distance;
        }
      });

      if (!selected) {
        selected = {
          y: word.y,
          words: []
        };
        rows.push(selected);
      }

      selected.words.push(word);

      selected.y = selected.words.reduce(
        (sum, item) => sum + item.y, 0
      ) / selected.words.length;
    });

    rows.forEach(row => {
      row.words.sort((a, b) => a.x - b.x);
    });

    return rows.sort((a, b) => a.y - b.y);
  }

  // ------------------------------------------
  // DETECTAR NÚMEROS
  // ------------------------------------------

  function extractNumbers(text) {
    const value = clean(text)
      .replace(/[Oo]/g, "0")
      .replace(/[Il|]/g, "1");

    return (value.match(/\d{1,2}/g) || [])
      .map(Number)
      .filter(n => n >= 1 && n <= 31);
  }

  // ------------------------------------------
  // ENCONTRAR FILA DE DÍAS
  // ------------------------------------------

  function findDateRow(rows) {
    let best = null;
    let bestScore = 0;

    rows.forEach((row, index) => {
      const found = [];

      row.words.forEach(word => {
        extractNumbers(word.text).forEach(day => {
          found.push({
            day,
            x: word.x,
            confidence: word.confidence
          });
        });
      });

      found.sort((a, b) => a.x - b.x);

      const unique = [];

      found.forEach(item => {
        const previous = unique[unique.length - 1];

        if (
          !previous ||
          Math.abs(item.x - previous.x) > 8
        ) {
          unique.push(item);
        }
      });

      if (unique.length < 3) return;

      const spread =
        unique[unique.length - 1].x - unique[0].x;

      // Favorece una fila de días distribuida
      // horizontalmente por el cronograma.
      const score = unique.length * 10 + spread / 100;

      if (score > bestScore) {
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
      if (row.y >= dateRow.row.y) return;

      row.words.forEach(word => {
        const value = clean(word.text).toLowerCase();

        Object.keys(MONTHS).forEach(name => {
          if (value.includes(name)) {
            const yearMatch = value.match(/20\d{2}/);

            result.push({
              month: MONTHS[name],
              year: yearMatch ? Number(yearMatch[0]) : null,
              x: word.x
            });
          }
        });
      });
    });

    return result.sort((a, b) => a.x - b.x);
  }

  // ------------------------------------------
  // CONSTRUIR FECHAS
  // ------------------------------------------

  function buildDates(dateRow, months) {
    const current = new Date();

    let currentMonth = current.getMonth();
    let currentYear = current.getFullYear();
    let previousDay = null;

    const result = [];

    dateRow.words.forEach(word => {
      let nearest = null;
      let distance = Infinity;

      months.forEach(month => {
        const d = Math.abs(month.x - word.x);

        if (d < distance) {
          nearest = month;
          distance = d;
        }
      });

      if (nearest && distance < 600) {
        currentMonth = nearest.month;

        if (nearest.year) {
          currentYear = nearest.year;
        }
      }

      const day = word.day;

      if (
        previousDay !== null &&
        day < previousDay &&
        previousDay >= 25 &&
        day <= 5
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
  // CALCULAR DISTANCIA ENTRE COLUMNAS
  // ------------------------------------------

  function getColumnSpacing(dates) {
    if (dates.length < 2) return 80;

    const distances = [];

    for (let i = 1; i < dates.length; i++) {
      const distance = dates[i].x - dates[i - 1].x;

      if (distance > 5) {
        distances.push(distance);
      }
    }

    if (!distances.length) return 80;

    distances.sort((a, b) => a - b);

    return distances[Math.floor(distances.length / 2)];
  }

  // ------------------------------------------
  // IDENTIFICAR PASAJEROS
  // ------------------------------------------

  function getPeople(rows, dateRow, dates) {
    if (!dates.length) return [];

    const spacing = getColumnSpacing(dates);

    // Límite entre la columna de nombres
    // y la primera columna de días.
    const firstDateX = dates[0].x;
    const nameLimit = firstDateX - spacing * 0.45;

    const people = [];

    rows.forEach(row => {
      if (row.y <= dateRow.row.y) return;

      const nameWords = row.words.filter(word => {
        return word.x < nameLimit;
      });

      if (!nameWords.length) return;

      const name = clean(
        nameWords.map(word => word.text).join(" ")
      )
        .replace(/^[^a-záéíóúñ]+/i, "")
        .replace(/[^a-záéíóúñ\s.'-]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (name.length < 3) return;
      if (!/[a-záéíóúñ]/i.test(name)) return;

      if (
        /feriado|vacaciones|nuevos equipos|nombre|personal|horario|total|observaciones/i.test(name)
      ) return;

      people.push({
        name,
        row
      });
    });

    return people;
  }

  // ------------------------------------------
  // OBTENER PALABRAS DE UNA CELDA
  // ------------------------------------------

  function getCellWords(row, dates, index) {
    const spacing = getColumnSpacing(dates);
    const current = dates[index];

    const left = index === 0
      ? current.x - spacing * 0.5
      : (dates[index - 1].x + current.x) / 2;

    const right = index === dates.length - 1
      ? current.x + spacing * 0.5
      : (current.x + dates[index + 1].x) / 2;

    return row.words.filter(word => {
      return word.x >= left && word.x < right;
    });
  }

  // ------------------------------------------
  // INTERPRETAR HORARIOS
  // ------------------------------------------

  function parseHours(text) {
    let value = clean(text).toLowerCase();

    value = value
      .replace(/[–—−]/g, "-")
      .replace(/[o]/g, "0")
      .replace(/[il|]/g, "1")
      .replace(/horas?/g, "")
      .replace(/hs?/g, "")
      .replace(/\s+/g, "");

    const matches = value.match(
      /(?:^|[^0-9])([0-2]?\d)-([0-2]?\d)(?=$|[^0-9])/g
    );

    if (!matches) return null;

    for (const item of matches) {
      const numbers = item.match(/(\d{1,2})-(\d{1,2})/);

      if (!numbers) continue;

      const start = Number(numbers[1]);
      const end = Number(numbers[2]);

      if (start > 23 || end > 23) continue;

      return {
        hours: start + "-" + end,
        status: "pendiente"
      };
    }

    return null;
  }

  // ------------------------------------------
  // FORMATO DE FECHA
  // ------------------------------------------

  function makeDate(date) {
    return (
      date.year + "-" +
      String(date.month + 1).padStart(2, "0") + "-" +
      String(date.day).padStart(2, "0")
    );
  }

  // ------------------------------------------
  // ANALIZAR TODAS LAS FILAS
  // ------------------------------------------

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
          .map(word => word.text)
          .join(" ");

        const parsed = parseHours(raw);

        if (!parsed) return;

        const confidence = Math.round(
          words.reduce(
            (sum, word) => sum + word.confidence, 0
          ) / words.length
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

    report(progress, 15, "Mejorando imagen...");

    const prepared = prepareOCR(image);

    report(progress, 30, "Reconociendo texto...");

    const data = await recognize(prepared, progress);

    report(progress, 80, "Analizando cronograma...");

    const words = getWords(data);
    const rows = clusterRows(words);

    if (!rows.length) {
      throw new Error(
        "No se pudo reconocer texto. Probá con una imagen más nítida."
      );
    }

    const dateRow = findDateRow(rows);

    if (!dateRow) {
      throw new Error(
        "No se identificó la fila de días. Revisá que se vea completa la parte superior del cronograma."
      );
    }

    report(progress, 85, "Identificando fechas...");

    const months = findMonths(rows, dateRow);
    const dates = buildDates(dateRow, months);

    if (!dates.length) {
      throw new Error("No se pudieron interpretar las fechas.");
    }

    report(progress, 90, "Buscando todos los pasajeros...");

    const people = getPeople(rows, dateRow, dates);

    report(progress, 94, "Leyendo horarios de cada fila...");

    const candidates = extractCandidates(
      rows,
      dateRow,
      dates
    );

    report(
      progress,
      100,
      "Lectura terminada: " +
      people.length +
      " pasajeros y " +
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
