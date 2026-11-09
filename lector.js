
/* ==========================================
   TRANSPORTE LEO - LECTOR OCR
   Corrección de detección de días y horarios
   ========================================== */

window.LeoReader = (function () {
  "use strict";

  function progress(callback, percent, message) {
    if (typeof callback === "function") {
      callback(percent, message);
    }
  }

  function clean(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

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

  function prepareImage(image) {
    const scale = Math.min(3, Math.max(1.5, 2400 / image.width));
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

    return canvas;
  }

  async function recognize(canvas, callback) {
    if (!window.Tesseract) {
      throw new Error("No se cargó Tesseract OCR.");
    }

    const worker = await Tesseract.createWorker("spa");

    try {
      await worker.setParameters({
        preserve_interword_spaces: "1"
      });

      const result = await worker.recognize(canvas);

      progress(callback, 75, "Texto reconocido.");

      return result.data;
    } finally {
      await worker.terminate();
    }
  }

  function getWords(data) {
    return (data.words || [])
      .filter(word => word.text && word.bbox)
      .map(word => ({
        text: clean(word.text),
        x: (word.bbox.x0 + word.bbox.x1) / 2,
        y: (word.bbox.y0 + word.bbox.y1) / 2,
        x0: word.bbox.x0,
        x1: word.bbox.x1,
        y0: word.bbox.y0,
        y1: word.bbox.y1,
        height: Math.max(1, word.bbox.y1 - word.bbox.y0),
        confidence: word.confidence || 0
      }));
  }

  function makeRows(words) {
    const sorted = words.slice().sort(
      (a, b) => a.y - b.y || a.x - b.x
    );

    const rows = [];

    sorted.forEach(word => {
      let rowFound = null;
      let distanceFound = Infinity;

      rows.forEach(row => {
        const distance = Math.abs(row.y - word.y);
        const tolerance = Math.max(9, word.height * 0.65);

        if (distance < tolerance && distance < distanceFound) {
          rowFound = row;
          distanceFound = distance;
        }
      });

      if (!rowFound) {
        rowFound = { y: word.y, words: [] };
        rows.push(rowFound);
      }

      rowFound.words.push(word);

      rowFound.y = rowFound.words.reduce(
        (sum, item) => sum + item.y, 0
      ) / rowFound.words.length;
    });

    rows.forEach(row => {
      row.words.sort((a, b) => a.x - b.x);
    });

    return rows.sort((a, b) => a.y - b.y);
  }

  // Acepta solamente números independientes.
  // No confunde 6-18hs o 19-7hs con días.
  function numbersIn(text) {
    let value = clean(text)
      .replace(/[Oo]/g, "0")
      .replace(/[Il|]/g, "1");

    value = value.replace(/^[^\d]+|[^\d]+$/g, "");

    if (!/^\d{1,2}$/.test(value)) {
      return [];
    }

    const number = Number(value);

    if (number < 1 || number > 31) {
      return [];
    }

    return [number];
  }

  // Busca la fila que más se parece a una secuencia de días.
  function findDaysRow(rows) {
    let best = null;
    let bestScore = -Infinity;

    rows.forEach((row, index) => {
      const found = [];

      row.words.forEach(word => {
        numbersIn(word.text).forEach(day => {
          found.push({
            day,
            x: word.x
          });
        });
      });

      found.sort((a, b) => a.x - b.x);

      const unique = [];

      found.forEach(item => {
        const last = unique[unique.length - 1];

        if (!last || Math.abs(last.x - item.x) > 8) {
          unique.push(item);
        }
      });

      if (unique.length < 3) return;

      let ascending = 0;
      let repeated = 0;

      for (let i = 1; i < unique.length; i++) {
        const previous = unique[i - 1].day;
        const current = unique[i].day;

        if (current > previous) {
          ascending++;
        } else if (current === previous) {
          repeated++;
        } else if (previous >= 25 && current <= 5) {
          ascending++;
        }
      }

      const spread =
        unique[unique.length - 1].x - unique[0].x;

      const score =
        unique.length * 8 +
        ascending * 14 -
        repeated * 8 +
        spread / 150 -
        index * 0.15;

      if (score > bestScore) {
        bestScore = score;
        best = {
          index,
          row,
          days: unique
        };
      }
    });

    return best;
  }

  function median(values) {
    if (!values.length) return 80;

    const sorted = values.slice().sort((a, b) => a - b);

    return sorted[Math.floor(sorted.length / 2)];
  }

  function getSpacing(days) {
    const distances = [];

    for (let i = 1; i < days.length; i++) {
      const distance = days[i].x - days[i - 1].x;

      if (distance > 5) {
        distances.push(distance);
      }
    }

    return median(distances);
  }

  function getDateObjects(dayRow) {
    const now = new Date();

    let month = now.getMonth();
    let year = now.getFullYear();
    let previousDay = null;

    return dayRow.days.map(item => {
      if (
        previousDay !== null &&
        item.day < previousDay &&
        previousDay >= 25 &&
        item.day <= 5
      ) {
        month++;

        if (month > 11) {
          month = 0;
          year++;
        }
      }

      previousDay = item.day;

      return {
        day: item.day,
        month,
        year,
        x: item.x
      };
    });
  }

  function formatDate(date) {
    return date.year + "-" +
      String(date.month + 1).padStart(2, "0") + "-" +
      String(date.day).padStart(2, "0");
  }

  function getPassengers(rows, dayRow, dates) {
    const spacing = getSpacing(dates);
    const firstDayX = dates[0].x;
    const nameLimit = firstDayX - spacing * 0.35;

    const passengers = [];

    rows.forEach(row => {
      if (row.y <= dayRow.row.y) return;

      const words = row.words.filter(
        word => word.x < nameLimit
      );

      if (!words.length) return;

      const name = clean(
        words.map(word => word.text).join(" ")
      )
        .replace(/[^a-záéíóúñü\s.'-]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (name.length < 3) return;

      if (
        /nombre|personal|horario|feriado|vacaciones|total|observaciones|turno/i.test(name)
      ) return;

      if (!/[a-záéíóúñ]/i.test(name)) return;

      passengers.push({
        name,
        row
      });
    });

    return passengers;
  }

  function getCell(row, dates, index) {
    const spacing = getSpacing(dates);
    const current = dates[index];

    const left = index === 0
      ? current.x - spacing * 0.55
      : (dates[index - 1].x + current.x) / 2;

    const right = index === dates.length - 1
      ? current.x + spacing * 0.55
      : (current.x + dates[index + 1].x) / 2;

    return row.words.filter(word =>
      word.x >= left && word.x < right
    );
  }

  function parseHours(text) {
    let value = clean(text).toLowerCase();

    value = value
      .replace(/[–—−]/g, "-")
      .replace(/[o]/g, "0")
      .replace(/[il|]/g, "1")
      .replace(/horas?/g, "")
      .replace(/hs?/g, "")
      .replace(/\s+/g, "");

    const matches = value.match(/\d{1,2}-\d{1,2}/g);

    if (!matches) return null;

    for (const match of matches) {
      const parts = match.split("-");
      const start = Number(parts[0]);
      const end = Number(parts[1]);

      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 && start <= 23 &&
        end >= 0 && end <= 23
      ) {
        return start + "-" + end;
      }
    }

    return null;
  }

  function extract(rows, dayRow, dates) {
    const passengers = getPassengers(rows, dayRow, dates);
    const candidates = [];

    passengers.forEach(passenger => {
      dates.forEach((date, index) => {
        const cellWords = getCell(
          passenger.row,
          dates,
          index
        );

        if (!cellWords.length) return;

        const raw = cellWords
          .map(word => word.text)
          .join(" ");

        const hours = parseHours(raw);

        if (!hours) return;

        const confidence = Math.round(
          cellWords.reduce(
            (sum, word) => sum + word.confidence,
            0
          ) / cellWords.length
        );

        candidates.push({
          person: passenger.name,
          date: formatDate(date),
          day: date.day,
          month: date.month + 1,
          year: date.year,
          raw,
          hours,
          confidence,
          status: "pendiente"
        });
      });
    });

    return {
      passengers,
      candidates
    };
  }

  async function scan(file, callback) {
    progress(callback, 0, "Preparando imagen...");

    const image = await loadImage(file);

    progress(callback, 15, "Preparando cronograma...");

    const canvas = prepareImage(image);

    progress(callback, 30, "Leyendo texto con OCR...");

    const data = await recognize(canvas, callback);
    const fullText = data.text || "";

    progress(callback, 80, "Analizando filas y columnas...");

    const words = getWords(data);
    const rows = makeRows(words);

    if (!rows.length) {
      throw new Error(
        "El OCR no pudo reconocer texto suficiente."
      );
    }

    const dayRow = findDaysRow(rows);

    if (!dayRow) {
      throw new Error(
        "No pude identificar la fila de días del calendario."
      );
    }

    const dates = getDateObjects(dayRow);

    progress(callback, 88, "Buscando pasajeros...");

    const result = extract(rows, dayRow, dates);

    progress(callback, 96, "Terminando lectura...");

    progress(
      callback,
      100,
      "Análisis terminado: " +
      result.passengers.length +
      " pasajeros y " +
      result.candidates.length +
      " horarios."
    );

    return {
      candidates: result.candidates,
      dates,
      text: fullText,
      passengersFound: result.passengers.length
    };
  }

  return {
    scan,
    parseHours
  };

})();
