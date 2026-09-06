# Redactor Sinaí

Web app para que la Dra. Priscila Molina (Clínica Sinaí, Mérida) dicte los hallazgos de una
consulta por voz y reciba el informe ya redactado y organizado, listo para revisar y descargar
como Word con el membrete real de la clínica.

## Cómo funciona

1. Elige el tipo de informe (Consulta o Doppler venoso).
2. Ingresa los datos del paciente y graba el dictado con el micrófono del navegador.
3. El audio se envía a Gemini (Google), que devuelve el informe ya redactado en la estructura
   correcta — sin inventar hallazgos que no se mencionaron.
4. La doctora revisa/corrige el texto y descarga el `.docx` ya relleno en la plantilla con el
   membrete de Clínica Sinaí.

Nada se guarda en el servidor: no hay base de datos ni historial de pacientes.

## Estructura del repo

```
/frontend/index.html          UI de una sola página (Firebase Hosting)
/functions/index.js           Backend (Cloud Functions, Node)
/functions/templates/         Plantillas .docx reales con el membrete de Clínica Sinaí
/assets/clinica-sinai-logo.png  Logo fuente usado en las plantillas
/firebase.json                Config de Hosting + rewrite /api/** -> Functions
/.firebaserc                  Id del proyecto de Firebase (placeholder, ver pasos abajo)
```

Las plantillas `.docx` ya incluyen el membrete real (logo, RIF J-31530031-1, dirección y
teléfonos de Clínica Sinaí Lumonty, C.A.), tomados de los datos disponibles. Si el diseño del
membrete cambia en el futuro, **basta con editar esos dos archivos de Word directamente en Word**
(o LibreOffice) y volver a subirlos al repo — no hace falta tocar código. El único requisito es
que el marcador `{contenido}` siga existiendo, intacto, en algún lugar del cuerpo del documento.

## Pasos manuales pendientes (fuera de lo que se automatiza aquí)

1. **Crear la API key de Gemini** (gratis): entra a https://aistudio.google.com/apikey y genera
   una key.
2. **Crear el repo de GitHub** para este proyecto (o usar uno existente) y subir este código.
3. **Crear el proyecto de Firebase** en https://console.firebase.google.com y pasarlo al
   **plan Blaze** (pago por uso). Esto es obligatorio porque las Cloud Functions gen 2 necesitan
   ese plan para poder llamar a APIs externas como Gemini. El uso esperado de una clínica pequeña
   no debería generar costo real (queda dentro del nivel gratuito), pero Firebase pide asociar
   una tarjeta igual.
4. **Instalar Firebase CLI** si no lo tienes: `npm install -g firebase-tools`, luego
   `firebase login`.
5. **Conectar el repo con el proyecto de Firebase**: dentro de la carpeta del proyecto, corre
   `firebase init hosting:github`. Esto genera el workflow de GitHub Actions que despliega
   automáticamente en cada push a la rama principal. Cuando pregunte el ID del proyecto de
   Firebase, ese es el valor que también debe quedar en `.firebaserc` (reemplaza
   `TU-PROYECTO-DE-FIREBASE-AQUI`).
6. **Instalar las dependencias del backend**: `cd functions && npm install`.
7. **Guardar la API key de Gemini como secreto**:
   `firebase functions:secrets:set GEMINI_API_KEY` (te pedirá pegar la key generada en el paso 1).
8. **Hacer commit y push** a la rama principal. El deploy debería dispararse solo vía GitHub
   Actions — verifica en la pestaña "Actions" del repo que termine en verde.
9. **Probar el flujo completo con datos de prueba** (nunca con datos reales de un paciente hasta
   confirmar que todo funciona bien).
10. **Compartir el link de Firebase Hosting** con la Dra. Molina. Puede guardarlo como acceso
    directo en el escritorio o el celular.

## Notas técnicas

- Modelo de Gemini usado: `gemini-3.8-flash` (acepta audio nativo — verificado en
  ai.google.dev/gemini-api/docs en septiembre 2026). El SDK de Node es `@google/genai`.
- El audio del navegador se graba como `audio/webm;codecs=opus` (formato nativo de
  `MediaRecorder`), que Gemini acepta directamente sin conversión.
- El `.docx` se genera con `docxtemplater` + `pizzip`, con la opción `linebreaks: true` para que
  los saltos de línea del texto de Gemini se conviertan en saltos de línea reales dentro del
  Word.
- La API key de Gemini se lee del secreto de Firebase (`defineSecret`), nunca queda expuesta al
  frontend.
