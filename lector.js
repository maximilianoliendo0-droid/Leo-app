
/* ==========================================
   LEO APP - LECTOR OCR DE CRONOGRAMAS
   Versión adaptada a tablas laborales
   ========================================== */

window.LeoReader = (function () {
  "use strict";

  // ------------------------------------------
  // ESPERAR A QUE OCR ESTÉ DISPONIBLE
  // ------------------------------------------

  async function waitForOCR() {
    let attempts = 0;

    while (!window.Tesseract && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (!window.Tesseract) {
      throw new Error(
        "No se pudo cargar Tesseract OCR. Revisá la conexión a internet."
      );
    }
  }

  // ------------------------------------------
  // CARGAR IMAGEN
  // ------------------------------------------

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("No se pudo abrir la imagen."));
      };

      img.src = url;
    });
  }

  // ------------------------------------------
  // PREPARAR IMAGEN
  // ------------------------------------------

  async function prepareImage(file) {
    const img = await loadImage(file);
    const canvas = document.createElement("canvas");

    const maxWidth = 2800;
    const scale = Math.min(1, maxWidth / img.width);

    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(
      img,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvas;
  }

  // ------------------------------------------
  // DETECTAR LÍNEAS DE LA TABLA
  // ------------------------------------------

  function detectLines(canvas, direction) {
    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    const width = canvas.width;
    const height = canvas.height;

    const image = ctx.getImageData(
      0, 0, width, height
    );

    const data = image.data;

    const horizontal = direction === "horizontal";

    const length = horizontal ? height : width;
    const otherLength = horizontal ? width : height;

    const scores = [];

    for (let p = 0; p < length; p++) {
      let dark = 0;
      let samples = 0;

      for (let q = 0; q < otherLength; q += 2) {
        const x = horizontal ? q : p;
        const y = horizontal ? p : q;

        const index = (y * width + x) * 4;

        const gray =
          data[index] * 0.299 +
          data[index + 1] * 0.587 +
          data[index + 2] * 0.114;

        if (gray < 150) dark++;

        samples++;
      }

      scores.push(samples ? dark / samples : 0);
    }

    const threshold = 0.25;

    const positions = [];
    let start = null;

    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= threshold) {
        if (start === null) start = i;
      } else if (start !== null) {
        positions.push(
          Math.round((start + i - 1) / 2)
        );

        start = null;
      }
    }

    if (start !== null) {
      positions.push(
        Math.round((start + length - 1) / 2)
      );
    }

    // Unir líneas que están muy próximas
    const result = [];

    positions.forEach(pos => {
      if (
        result.length === 0 ||
        pos - result[result.length - 1] > 4
      ) {
        result.push(pos);
      } else {
        const last = result.length - 1;

        result[last] = Math.round(
          (result[last] + pos) / 2
        );
      }
    });

    return result;
  }

  // ------------------------------------------
  // RECORTAR UNA CELDA
  // ------------------------------------------

  function cropCell(canvas, x1, y1, x2, y2) {
    const margin = 2;

    const x = Math.max(0, x1 + margin);
    const y = Math.max(0, y1 + margin);

    const w = Math.max(
      1,
      x2 - x1 - margin * 2
    );

    const h = Math.max(
      1,
      y2 - y1 - margin * 2
    );

    const cropped = document.createElement("canvas");

    cropped.width = w;
    cropped.height = h;

    cropped.getContext("2d").drawImage(
      canvas,
      x, y, w, h,
      0, 0, w, h
    );

    return cropped;
  }

  // ------------------------------------------
  // LEER TEXTO OCR
  // ------------------------------------------

  async function readCell(canvas) {
    const result = await window.Tesseract.recognize(
      canvas,
      "spa",
      {
        logger: function () {}
      }
    );

    return {
      text: (result.data.text || "").trim(),
      confidence: result.data.confidence || 0
    };
  }

  // ------------------------------------------
  // LIMPIAR TEXTO
  // ------------------------------------------

  function cleanText(text) {
    return String(text || "")
      .replace(/\n/g, " ")
      .replace(/\|/g, "I")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ------------------------------------------
  // NORMALIZAR NÚMEROS DE DÍAS
  // ------------------------------------------

  function parseDay(text) {
    let value = cleanText(text)
      .replace(/[Oo]/g, "0")
      .replace(/[Il|]/g, "1")
      .replace(/S/g, "5")
      .trim();

    const match = value.match(
      /(?:^|\D)([0-3]?\d)(?:\D|$)/
    );

    if (!match) return null;

    const day = Number(match[1]);

    if (day >= 1 && day <= 31) {
      return day;
    }

    return null;
  }

  // ------------------------------------------
  // BUSCAR FILA DE FECHAS
  // ------------------------------------------

  function findHeaderRow(rows) {
    let bestIndex = -1;
    let bestScore = 0;

    rows.forEach((row, index) => {
      const days = row.map(cell =>
        parseDay(cell.text)
      );

      let count = 0;
      let consecutive = 0;
      let previous = null;

      days.forEach(day => {
        if (day === null) return;

        count++;

        if (
          previous !== null &&
          (
            day === previous + 1 ||
            (previous === 31 && day === 1)
          )
        ) {
          consecutive++;
        }

        previous = day;
      });

      const score =
        count * 2 +
        consecutive * 3;

      if (
        count >= 3 &&
        score > bestScore
      ) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  // ------------------------------------------
  // DETECTAR HORARIOS
  // ------------------------------------------

  function parseHours(text) {
    let value = cleanText(text)
      .toLowerCase()
      .replace(/hs?/g, "")
      .replace(/\s/g, "")
      .replace(/[–—]/g, "-");

    // Horario completo: 6-18, 19-7, 15-20
    const match = value.match(
      /(?:^|[^0-9])([0-2]?\d)-([0-2]?\d)(?:$|[^0-9])/
    );

    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);

      if (
        start <= 23 &&
        end <= 23
      ) {
        return {
          hours: start + "-" + end,
          status: "pendiente"
        };
      }
    }

    // Un solo número: posible turno de 12 horas.
    // Siempre requiere confirmación manual.
    const single = value.match(
      /^([0-2]?\d)$/
    );

    if (single) {
      const start = Number(single[1]);

      if (start <= 23) {
        const end = (start + 12) % 24;

        return {
          hours: start + "-" + end,
          status: "inferido"
        };
      }
    }

    return null;
  }

  // ------------------------------------------
  // IDENTIFICAR FILAS DE PERSONAS
  // ------------------------------------------

  function validPerson(text) {
    const person = cleanText(text);

    if (person.length < 3) return false;

    const ignored = [
      "nombre",
      "apellido",
      "personal",
      "empleado",
      "sector",
      "nuevos equipos",
      "feriado",
      "vacaciones"
    ];

    if (
      ignored.includes(person.toLowerCase())
    ) {
      return false;
    }

    // Debe contener al menos una letra
    if (!/[a-záéíóúñ]/i.test(person)) {
      return false;
    }

    return true;
  }

  // ------------------------------------------
  // ESCANEAR CRONOGRAMA
  // ------------------------------------------

  async function scan(file, progress) {
    if (typeof progress !== "function") {
      progress = function () {};
    }

    progress("Preparando imagen...");

    await waitForOCR();

    const canvas = await prepareImage(file);

    progress("Detectando líneas de la tabla...");

    const horizontal = detectLines(
      canvas,
      "horizontal"
    );

    const vertical = detectLines(
      canvas,
      "vertical"
    );

    if (
      horizontal.length < 3 ||
      vertical.length < 3
    ) {
      throw new Error(
        "No se pudo detectar una cuadrícula suficiente. Probá con una imagen más clara y completa."
      );
    }

    progress("Analizando filas y columnas...");

    const rows = [];

    for (
      let r = 0;
      r < horizontal.length - 1;
      r++
    ) {
      const row = [];

      for (
        let c = 0;
        c < vertical.length - 1;
        c++
      ) {
        const cellCanvas = cropCell(
          canvas,
          vertical[c],
          horizontal[r],
          vertical[c + 1],
          horizontal[r + 1]
        );

        const result = await readCell(
          cellCanvas
        );

        row.push({
          text: cleanText(result.text),
          confidence: result.confidence
        });
      }

      rows.push(row);

      progress(
        "Leyendo fila " +
        (r + 1) +
        " de " +
        (horizontal.length - 1) +
        "..."
      );
    }

    // Encontrar fila de números de días
    progress("Buscando fechas del cronograma...");

    const headerIndex = findHeaderRow(rows);

    if (headerIndex === -1) {
      throw new Error(
        "No pude identificar los días del cronograma. Revisá que los números de las fechas se vean completos."
      );
    }

    const header = rows[headerIndex];

    const days = header.map(cell =>
      parseDay(cell.text)
    );

    progress("Fechas detectadas. Buscando pasajeros...");

    const candidates = [];

    // Las filas posteriores a las fechas
    // corresponden a los trabajadores.
    for (
      let r = headerIndex + 1;
      r < rows.length;
      r++
    ) {
      const row = rows[r];

      if (!row.length) continue;

      // Primera columna: nombre del trabajador
      const person = cleanText(row[0].text);

      if (!validPerson(person)) {
        continue;
      }

      // Las demás columnas corresponden a los días
      for (
        let c = 1;
        c < row.length;
        c++
      ) {
        const day = days[c];

        const raw = row[c].text;

        if (!day || !raw) continue;

        const parsed = parseHours(raw);

        if (!parsed) continue;

        candidates.push({
          person: person,
          day: day,
          raw: raw,
          hours: parsed.hours,
          confidence: row[c].confidence,
          status: parsed.status
        });
      }
    }

    progress(
      "Lectura terminada. Se encontraron " +
      candidates.length +
      " posibles horarios."
    );

    return {
  candidates: candidates
};

  // ------------------------------------------
  // API PARA INDEX.HTML
  // ------------------------------------------

  return {
    scan: scan,
    parseHours: parseHours,
    parseDay: parseDay
  };

})();
