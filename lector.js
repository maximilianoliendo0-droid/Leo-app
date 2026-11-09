
/* ==========================================
   TRANSPORTE LEO - LECTOR OCR
   Doble lectura y detección flexible
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
    const scale = Math.min(3, Math.max(1.5, 2600 / image.width));
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
      0, 0,
      image.width, image.height,
      0, 0,
      canvas.width, canvas.height
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
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: "6"
      });

      const normal = await worker.recognize(canvas);

      progress(
        callback,
        58,
        "Primera lectura terminada. Probando otra distribución..."
      );

      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: "11"
      });

      const dispersed = await worker.recognize(canvas);

      progress(callback, 76, "Comparando las dos lecturas...");

      return [
        {
          mode: "Lectura ordenada",
          data: normal.data
        },
        {
          mode: "Lectura dispersa",
          data: dispersed.data
        }
      ];
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
      let best = null;
      let bestDistance = Infinity;

      rows.forEach(row => {
        const distance = Math.abs(row.y - word.y);
        const tolerance = Math.max(
          12,
          Math.min(word.height, row.height || word.height) * 0.8
        );

        if (distance <= tolerance && distance < bestDistance) {
          best = row;
          bestDistance = distance;
        }
      });

      if (!best) {
        best = {
          y: word.y,
          height: word.height,
          words: []
        };
        rows.push(best);
      }

      best.words.push(word);

      best.y = best.words.reduce(
        (sum, item) => sum + item.y,
        0
      ) / best.words.length;

      best.height = best.words.reduce(
        (sum, item) => sum + item.height,
        0
      ) / best.words.length;
    });

    rows.forEach(row => {
      row.words.sort((a, b) => a.x - b.x);
    });

    return rows.sort((a, b) => a.y - b.y);
  }

  function numbersIn(text) {
    const value = clean(text)
      .replace(/[Oo]/g, "0")
      .replace(/[Il|]/g, "1")
      .replace(/^[^\d]+|[^\d]+$/g, "");

    const matches = value.match(/\d{1,2}/g) || [];

    return matches
      .map(Number)
      .filter(number => number >= 1 && number <= 31);
  }

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
      let descending = 0;

      for (let i = 1; i < unique.length; i++) {
        const previous = unique[i - 1].day;
        const current = unique[i].day;

        if (current > previous) {
          ascending++;
        } else if (
          previous >= 25 &&
          current <= 5
        ) {
          ascending++;
        } else {
          descending++;
        }
      }

      const spread =
        unique[unique.length - 1].x - unique[0].x;

      const score =
        unique.length * 10 +
        ascending * 12 -
        descending * 5 +
        spread / 150 -
        index * 0.1;

      if (score > bestScore) {
        bestScore = score;

        best = {
          index,
          row,
          days: unique,
          score
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
        /nombre|personal|horario|feriado|vacaciones|total|observaciones|turno|lunes|martes|miercoles|jueves|viernes|sabado|domingo/i.test(name)
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

  function buildDiagnostic(rows, dayRow, dates, result) {
    const out = [];

    out.push(
      "PALABRAS OCR: " +
      rows.reduce((n, row) => n + row.words.length, 0)
    );

    out.push("FILAS OCR: " + rows.length);

    if (dayRow) {
      out.push(
        "FILA DE DIAS DETECTADA: Y=" +
        Math.round(dayRow.row.y) +
        " | DIAS: " +
        dayRow.days.map(item =>
          item.day + "@X" + Math.round(item.x)
        ).join("  ")
      );
    } else {
      out.push("FILA DE DIAS DETECTADA: NO");
      out.push("NUMEROS RECONOCIDOS:");

      rows.forEach(row => {
        const nums = [];

        row.words.forEach(word => {
          numbersIn(word.text).forEach(day => {
            nums.push(day + "@X" + Math.round(word.x));
          });
        });

        if (nums.length) {
          out.push(
            "Y=" + Math.round(row.y) +
            " | " + nums.join(" ")
          );
        }
      });
    }

    if (result) {
      out.push(
        "PASAJEROS DETECTADOS: " +
        result.passengers.length
      );

      result.passengers.forEach((p, i) => {
        out.push(
          "PASAJERO " + (i + 1) +
          " | Y=" + Math.round(p.row.y) +
          " | " + p.name
        );
      });

      out.push(
        "HORARIOS DETECTADOS: " +
        result.candidates.length
      );

      result.candidates.slice(0, 100).forEach(c => {
        out.push(
          c.person + " | " +
          c.date + " | " +
          c.hours + " | OCR: " +
          c.raw
        );
      });
    }

    out.push("");
    out.push("FILAS OCR CON POSICIONES:");

    rows.slice(0, 50).forEach((row, i) => {
      const parts = row.words.map(word =>
        Math.round(word.x) + ":" + word.text
      );

      out.push(
        "FILA " + (i + 1) +
        " Y=" + Math.round(row.y) +
        " | " + parts.join("  ")
      );
    });

    if (rows.length > 50) {
      out.push(
        "... se omitieron " +
        (rows.length - 50) +
        " filas adicionales."
      );
    }

    return out.join("\n");
  }

  function analyzeReading(reading) {
    const data = reading.data;
    const words = getWords(data);
    const rows = makeRows(words);

    let dayRow = null;
    let dates = [];
    let result = null;

    if (rows.length) {
      dayRow = findDaysRow(rows);

      if (dayRow) {
        dates = getDateObjects(dayRow);
        result = extract(rows, dayRow, dates);
      }
    }

    return {
      mode: reading.mode,
      data,
      words,
      rows,
      dayRow,
      dates,
      result,
      candidates: result ? result.candidates.length : 0,
      passengers: result ? result.passengers.length : 0,
      dayCount: dayRow ? dayRow.days.length : 0
    };
  }

  async function scan(file, callback) {
    progress(callback, 0, "Preparando imagen...");

    const image = await loadImage(file);

    progress(callback, 15, "Preparando cronograma...");

    const canvas = prepareImage(image);

    progress(callback, 30, "Realizando dos lecturas OCR...");

    const readings = await recognize(canvas, callback);

    progress(callback, 80, "Analizando días, pasajeros y horarios...");

    const attempts = readings.map(analyzeReading);

    attempts.sort((a, b) =>
      b.candidates - a.candidates ||
      b.passengers - a.passengers ||
      b.dayCount - a.dayCount ||
      b.words.length - a.words.length
    );

    const best = attempts[0];

    const rows = best.rows;
    const dayRow = best.dayRow;
    const dates = best.dates;
    const result = best.result;

    const diagnostic = buildDiagnostic(
      rows,
      dayRow,
      dates,
      result
    );

    const comparison = [
      "COMPARACION DE LECTURAS OCR:",
      ...attempts.map(item =>
        item.mode.toUpperCase() +
        ": " + item.candidates + " horarios, " +
        item.passengers + " pasajeros, " +
        item.dayCount + " días y " +
        item.words.length + " palabras."
      ),
      "LECTURA ELEGIDA: " + best.mode.toUpperCase()
    ].join("\n");

    const passengersCount = result
      ? result.passengers.length
      : 0;

    const candidatesCount = result
      ? result.candidates.length
      : 0;

    progress(callback, 96, "Terminando diagnóstico...");

    progress(
      callback,
      100,
      "Análisis terminado: " +
      passengersCount +
      " pasajeros y " +
      candidatesCount +
      " horarios."
    );

    return {
      candidates: result ? result.candidates : [],
      dates,
      text:
        (best.data.text || "") +
        "\n\n========== COMPARACION OCR ==========\n" +
        comparison +
        "\n\n========== DIAGNOSTICO ==========\n" +
        diagnostic,
      passengersFound: passengersCount
    };
  }

  return {
    scan,
    parseHours
  };

})();
