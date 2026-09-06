const path = require("path");
const fs = require("fs");

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const express = require("express");

const { GoogleGenAI } = require("@google/genai");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

// Verificado en ai.google.dev/gemini-api/docs (septiembre 2026):
// modelo vigente con soporte de audio nativo, paquete npm actual del SDK de Node.
const MODELO_GEMINI = "gemini-3.8-flash";

// Secreto de Firebase con la API key de Gemini.
// Se crea con: firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const ESQUELETOS = {
  consulta: `INFORME MEDICO DE CONSULTA
Fecha: / Nombre: / C.I.: / Edad:

MOTIVO DE CONSULTA:
(breve, tal como lo dijo la doctora)

ENFERMEDAD ACTUAL:
(narrativa)

EXAMEN FISICO:
(primero una linea con los signos vitales mencionados: TA, Pulso, FR, Talla, Peso, SatO2, Temp.
Si se dieron talla en cm y peso en kg, calcular el IMC = peso / (talla_m)^2, redondeado a 2 decimales.
Luego, organizar por aparatos/sistemas SOLO lo que la doctora haya mencionado: ORL, Cuello, Torax,
Cardiovascular, Abdomen, Miembros inferiores, Pulsos perifericos, Pies, u otros -- nunca inventar
sistemas no mencionados.)

DIAGNOSTICO(S):
(numerados, derivados solo de lo dicho)

CONDUCTA:
(el plan/tratamiento indicado, en prosa clara)`,

  doppler: `ULTRASONIDO DOPPLER COLOR DE MIEMBROS INFERIORES
Fecha: / Nombre: / C.I.: / Edad:

Pierna derecha:
(hallazgos de safena mayor, safena externa/menor, sistema venoso profundo, arterias -- tal como
se dictaron, en prosa clinica ordenada)

Pierna izquierda:
(mismo formato)

Conclusion diagnostica del ultrasonido:
(resumen breve, 1-3 lineas)

DIAGNOSTICO:
(lista numerada, derivada solo de lo dictado)

CONDUCTA:
(plan/tratamiento indicado, en prosa)`,
};

const NOMBRES_PLANTILLA = {
  consulta: "informe-consulta.docx",
  doppler: "doppler.docx",
};

function construirPrompt(tipoInforme, datosPaciente) {
  const esqueleto = ESQUELETOS[tipoInforme];
  const datosTexto = `Nombre: ${datosPaciente.nombre}
C.I.: ${datosPaciente.cedula}
Edad: ${datosPaciente.edad}
Fecha: ${datosPaciente.fecha}`;

  return `Eres un asistente de redaccion clinica que ayuda a una medica cirujana general, especialista en
patologia venosa periferica, en Merida, Venezuela, a convertir una nota de voz en un informe medico
formal en espanol, con terminologia clinica estandar.

REGLA DE SEGURIDAD, OBLIGATORIA: nunca inventes ni asumas hallazgos, signos vitales, diagnosticos o
antecedentes que la doctora no haya mencionado en el audio. Si un dato no fue mencionado, omitelo del
informe; jamas lo rellenes por tu cuenta. No agregues diagnosticos que no se desprendan directamente
de lo dicho en el audio.

Escucha el audio adjunto (la doctora dictando los hallazgos de una consulta, con su historia en papel
como apoyo) y redacta el informe siguiendo EXACTAMENTE esta estructura, en este orden:

${esqueleto}

Datos del paciente (ya capturados, no vienen del audio):
${datosTexto}

Devuelve UNICAMENTE el texto del informe ya redactado, listo para insertar en la plantilla de Word. No
agregues explicaciones tuyas antes ni despues, no uses markdown ni asteriscos, usa texto plano con
mayusculas para los titulos de seccion.`;
}

function validarDatosPaciente(datosPaciente) {
  if (!datosPaciente || typeof datosPaciente !== "object") return false;
  const { nombre, cedula, edad, fecha } = datosPaciente;
  return Boolean(nombre && cedula && edad && fecha);
}

function normalizarMimeType(mimeType) {
  // Gemini rechaza el mimeType si trae parametros de codec (ej. el
  // "audio/webm;codecs=opus" que reporta MediaRecorder en Chrome) --
  // solo acepta el tipo base.
  return (mimeType || "").split(";")[0].trim();
}

function esErrorTemporal(err) {
  const status = err && err.status;
  return status === 503 || status === 429;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generarInformeConGemini({ audioBase64, mimeType, tipoInforme, datosPaciente }) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });
  const prompt = construirPrompt(tipoInforme, datosPaciente);

  const intentos = 3;
  let ultimoError;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const response = await ai.models.generateContent({
        model: MODELO_GEMINI,
        contents: [
          { text: prompt },
          { inlineData: { mimeType: normalizarMimeType(mimeType), data: audioBase64 } },
        ],
      });

      const texto = (response.text || "").trim();
      if (!texto) {
        throw new Error("Gemini no devolvio texto para este audio.");
      }
      return texto;
    } catch (err) {
      ultimoError = err;
      const quedanIntentos = intento < intentos;
      if (quedanIntentos && esErrorTemporal(err)) {
        logger.warn(`Gemini no disponible (intento ${intento}/${intentos}), reintentando...`, err);
        await esperar(1000 * 2 ** (intento - 1));
        continue;
      }
      throw err;
    }
  }

  throw ultimoError;
}

function generarDocx(tipoInforme, texto) {
  const nombreArchivo = NOMBRES_PLANTILLA[tipoInforme];
  const rutaPlantilla = path.join(__dirname, "templates", nombreArchivo);
  const contenidoPlantilla = fs.readFileSync(rutaPlantilla, "binary");

  const zip = new PizZip(contenidoPlantilla);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render({ contenido: texto });

  return doc.getZip().generate({ type: "nodebuffer" });
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.post("/api/generarInforme", async (req, res) => {
  try {
    const { audioBase64, mimeType, tipoInforme, datosPaciente } = req.body || {};

    if (!audioBase64 || !mimeType) {
      return res.status(400).json({ error: "Falta el audio grabado." });
    }
    if (!ESQUELETOS[tipoInforme]) {
      return res.status(400).json({ error: "Tipo de informe invalido." });
    }
    if (!validarDatosPaciente(datosPaciente)) {
      return res.status(400).json({ error: "Faltan datos del paciente (nombre, cedula, edad, fecha)." });
    }

    const texto = await generarInformeConGemini({ audioBase64, mimeType, tipoInforme, datosPaciente });
    return res.status(200).json({ texto });
  } catch (err) {
    logger.error("Error en /generarInforme", err);
    return res.status(500).json({ error: "No se pudo generar el informe. Intenta de nuevo." });
  }
});

app.post("/api/generarWord", async (req, res) => {
  try {
    const { texto, tipoInforme, datosPaciente } = req.body || {};

    if (!texto || typeof texto !== "string") {
      return res.status(400).json({ error: "Falta el texto del informe." });
    }
    if (!NOMBRES_PLANTILLA[tipoInforme]) {
      return res.status(400).json({ error: "Tipo de informe invalido." });
    }

    const buffer = generarDocx(tipoInforme, texto);
    const nombrePaciente = (datosPaciente && datosPaciente.nombre) || "informe";
    const nombreDescarga = `informe-${nombrePaciente.replace(/\s+/g, "_")}.docx`;

    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.set("Content-Disposition", `attachment; filename="${nombreDescarga}"`);
    return res.status(200).send(buffer);
  } catch (err) {
    logger.error("Error en /generarWord", err);
    return res.status(500).json({ error: "No se pudo generar el documento Word." });
  }
});

exports.api = onRequest(
  {
    secrets: [GEMINI_API_KEY],
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  app
);
