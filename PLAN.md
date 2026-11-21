# Plan de beta personal: traducción español–inglés en reuniones

Beta de uso personal para Windows 11, cuatro días a unas cuatro horas (unas 16 horas en total). Primera prueba en Zoom. Presupuesto de API: 0 USD, así que el reconocimiento, la traducción y la síntesis corren en la máquina.

Este documento no implementa el motor de audio. El motor entra el día 2, solo si el día 1 demuestra que el micrófono y el dispositivo virtual se pueden aislar.

## Contexto fijado

| Dato | Decisión |
| --- | --- |
| Sistema | Windows 11, proceso nativo de Windows |
| Experiencia | TypeScript, React y Node.js en proyectos pequeños o medianos |
| Tiempo | Unas 4 horas por día |
| API | 0 USD: modelos y voces locales |
| Primera reunión | Zoom |
| Recorrido A | Micrófono físico → español a inglés → salida virtual, que Zoom usa como micrófono |
| Recorrido B | Audio de la reunión → inglés a español → subtítulos, sin síntesis |
| Interfaz | Electron + React + TypeScript + Vite |
| Secretos y procesos | Backend Node.js local. Con presupuesto cero guarda rutas de modelos, no claves |
| Traducción | Adaptador independiente de la interfaz |

El código puede editarse desde WSL2. Las pruebas de audio se lanzan en Windows. WSL2 no ve los dispositivos WASAPI ni el cable virtual, así que un Electron arrancado dentro de Linux no sirve como evidencia.

## Riesgos de captura y de salida

Estos riesgos se cierran el día 1, antes de conectar reconocimiento o traducción.

### 1. WebRTC no fabrica el micrófono de Zoom

`getUserMedia` lee un dispositivo de grabación que ya existe. No crea uno nuevo.

- Recorrido A, captura: compatible. El micrófono físico entra por `getUserMedia`.
- Recorrido A, salida: compatible solo como reproducción hacia un dispositivo de reproducción ya instalado (`setSinkId` o el selector de salida de Chromium). El nombre que Zoom debe elegir como micrófono lo publica el controlador virtual, no la aplicación.
- Recorrido B: incompatible como captura directa de la sesión de audio de Zoom. Zoom es una aplicación nativa. `getUserMedia` no puede engancharse a su mezcla interna.

Controlador previsto, instalado por separado y no empaquetado: VB-CABLE de VB-Audio (un cable gratuito). La aplicación escribe en **CABLE Input**. Zoom toma el micrófono **CABLE Output**.

### 2. Un solo cable mezcla los dos recorridos

Si el recorrido B escucha el mismo extremo por el que sale el inglés del recorrido A, Zoom recibe la traducción de la propia reunión y los subtítulos transcriben la voz sintética.

Aislamiento obligatorio:

- Zoom, altavoz: auriculares reales (dispositivo de reproducción por defecto).
- Zoom, micrófono: **CABLE Output**.
- La aplicación, salida del recorrido A: solo **CABLE Input**.
- La aplicación, captura del recorrido B: el loopback del altavoz de los auriculares, nunca **CABLE Output**.

Prueba de aislamiento del día 1: reproducir un tono por **CABLE Input** y confirmar que la captura del recorrido B no lo contiene. Si lo contiene, el recorrido B no se conecta a traducción.

### 3. El loopback de la reunión en Windows 11 es frágil

Orden de intento para el recorrido B:

1. `getDisplayMedia` con audio de sistema en Electron reciente, descartando el vídeo. En Windows suele exigir un track de vídeo y un consentimiento. Sirve si el tono del cable no aparece en esa captura.
2. Si esa captura llega muda o incluye el cable, segundo dispositivo virtual (otro cable o el mezclador gratuito Voicemeeter): Zoom reproduce hacia ese dispositivo y la aplicación lo abre con `getUserMedia` como si fuera un micrófono. Quien escucha activa “escuchar este dispositivo” hacia los auriculares.

No implementar un addon nativo WASAPI en estos cuatro días. Si los dos intentos fallan, el día 3 se limita a subtítulos desde un archivo WAV de inglés y se anota el hueco con Zoom.

### 4. Zoom y Windows se disputan el micrófono físico

El micrófono físico lo abre solo esta aplicación. Zoom no debe tenerlo seleccionado. Si los dos lo abren, aparecen recortes, supresión de ruido sobre la voz original y un nivel inestable.

Riesgos asociados en Windows 11:

- Privacidad → Micrófono denegado para la aplicación de escritorio.
- “Modo exclusivo” de otro programa bloqueando el dispositivo.
- El dispositivo de comunicaciones predeterminado vuelve al micrófono físico al conectar auriculares.

La prueba del día 1 incluye desconectar y volver a conectar los auriculares y comprobar que Zoom sigue en **CABLE Output**.

### 5. El retorno acústico y el retorno digital

Los altavoces del portátil hacen que el inglés sintético entre otra vez por el micrófono. Los auriculares son parte del criterio de aceptación, no un consejo opcional.

La supresión de ruido y el control automático de ganancia de Zoom degradan la voz sintética. Durante la prueba se usa el audio original de Zoom (música de alta fidelidad, o el ajuste equivalente de la versión instalada) y se anota si la frase sigue siendo inteligible.

### 6. Relojes, formato y latencia local

Objetivo de la beta: una frase corta española sale en inglés por el cable en menos de unos 5 segundos en esta máquina. No es interpretación simultánea.

Con presupuesto cero el reconocimiento es por segmentos con detección de voz, no un stream profesional. Modelos previstos:

- Reconocimiento: `whisper.cpp`, modelo multilingüe `base` (bajar a `tiny` o `small` según la CPU medida el día 2).
- Traducción: Argos Translate local, pares `es→en` y `en→es`, en un proceso aparte invocado por el backend.
- Síntesis, solo recorrido A: una voz inglesa de Piper. El recorrido B no sintetiza.

Riesgos de formato: Zoom y el cable trabajan a 48 kHz; los modelos esperan 16 kHz mono. El backend remuestrea. Si el día 2 el modelo `base` va más lento que el tiempo real en un WAV de 10 segundos, se cambia el modelo ese mismo día y se registra el número. No se añade una API de pago para “salvar” la latencia.

### 7. La instalación del cable pide administrador

VB-CABLE puede pedir reinicio. Eso cabe en el día 1. La aplicación no descarga ni registra el controlador. El plan asume que el dispositivo ya aparece en `mmsys.cpl` antes de escribir el medidor de nivel.

### 8. Licencias y consentimiento

Los binarios y las voces se eligen con licencia compatible con uso local (Whisper MIT, voces Piper según el modelo concreto, paquetes Argos según su licencia). No se copian marcas, interfaces ni código de intérpretes comerciales.

En una reunión real, quien use la beta avisa a las otras personas de que hay traducción automática. La beta no entra sola a la reunión ni publica audio por su cuenta.

## Arquitectura mínima

```text
Micrófono físico
  → renderer (nivel y control)
  → backend local (segmentos, 16 kHz)
  → adaptador: reconocimiento → traducción es→en → síntesis
  → reproducción solo hacia CABLE Input
  → Zoom usa CABLE Output como micrófono

Auriculares (audio de Zoom)
  → captura de sistema o segundo cable
  → backend
  → adaptador: reconocimiento → traducción en→es
  → subtítulos en el renderer
```

El adaptador expone una interfaz propia (`recognize`, `translate`, `synthesize`) y no importa React ni Electron. El día 2 la implementación es local. Cambiarla por un proveedor con clave queda fuera de estos cuatro días, pero la interfaz no recibe tipos de la interfaz gráfica para que ese cambio sea posible después.

El backend local es el único proceso que conoce rutas de modelos y, más adelante, secretos. El renderer habla con él por el puente de Electron. No hay cuentas, base de datos ni red obligatoria en la beta.

Los dos recorridos no comparten estado de audio. Se pueden activar por separado. El recorrido B nunca escribe al cable.

## Estructura de carpetas

Propuesta pequeña. No crear el árbol hasta el día 1.

```text
traductorMizar/
  PLAN.md
  apps/
    desktop/                 Electron + Vite + React + TypeScript
      src/main/              proceso principal y puente
      src/preload/
      src/renderer/          dos paneles: recorrido A y recorrido B
    backend/                 Node.js local: segmentos, remuestreo, procesos
  packages/
    translation/             interfaz del adaptador, sin UI
      src/types.ts
      src/local/             whisper.cpp, Argos y Piper (día 2+)
  tools/                     notas de instalación del cable y comprobaciones manuales
```

Sin carpetas de autenticación, persistencia, pagos ni bots.

## Fuera de alcance

- Cuentas de usuario, base de datos y pagos.
- Clonación de voz y voces a medida.
- Unirse a Zoom o Meet por bot, SDK de reunión o automatización del cliente.
- macOS, Linux nativo y una segunda plataforma de reuniones. Meet queda anotado como seguimiento, sin trabajo en estos cuatro días.
- Addon nativo WASAPI, cancelación de eco propia y streaming de pago.
- Empaquetado instalable firmado. Basta con `electron-vite` en desarrollo, lanzado desde Windows.

## Hitos

Cada día termina con los criterios de ese día. Si un criterio de audio falla, el día siguiente no añade modelos: se corrige el camino de audio.

### Día 1 — Carcasa y prueba de aislamiento

Horas previstas: 4.

- Inicializar git y el esqueleto `apps/desktop` (Electron, React, TypeScript, Vite) más `apps/backend` y `packages/translation` vacíos, con la interfaz del adaptador en tipos solamente.
- Panel con dos recorridos etiquetados en español, botón de prueba y selector de dispositivos. Sin marca de terceros.
- Medidor del micrófono físico.
- Reproducir un WAV corto solo hacia **CABLE Input**.
- Comprobar en la configuración de audio de Zoom, o en la grabadora de Windows apuntando a **CABLE Output**, que ese WAV se oye.
- Intentar la captura del recorrido B y ejecutar la prueba del tono.
- Anotar en `tools/audio-windows.md` los nombres exactos de los dispositivos de esta máquina y el resultado del loopback.

Criterios de aceptación:

- Electron arranca en Windows 11, fuera de WSL2, y enumera el micrófono físico y **CABLE Input**.
- Un WAV de prueba se oye al grabar **CABLE Output** y no se oye por los auriculares.
- Queda escrito si el recorrido B es loopback de pantalla o segundo cable, y si el tono del cable está ausente de esa captura.
- Zoom, en su prueba de micrófono, muestra nivel cuando la aplicación reproduce hacia el cable, con el micrófono de Zoom en **CABLE Output** y el altavoz en los auriculares.
- No hay llamada a un modelo de voz.

### Día 2 — Recorrido A local

Horas previstas: 4.

- Implementar el adaptador local: segmento de voz → `whisper.cpp` → Argos `es→en` → Piper inglés.
- El backend remuestrea a 16 kHz mono y mide el tiempo de cada etapa.
- El renderer muestra texto reconocido, texto traducido y la salida sigue yendo solo al cable.
- Medir `base` con un WAV de unos 10 segundos. Si es más lento que el tiempo real, fijar otro modelo ggml el mismo día.

Criterios de aceptación:

- Una frase corta dicha al micrófono físico, en español, produce texto en inglés y audio inglés por **CABLE Output**.
- La suma de reconocimiento, traducción y síntesis de esa frase queda bajo unos 5 segundos, o queda registrado el modelo más pequeño que sí lo cumple y la cifra medida.
- Con los auriculares puestos, el micrófono no reinyecta el inglés sintético de forma audible en el texto reconocido.
- El recorrido B sigue apagado. La interfaz del adaptador no importa módulos de React.

### Día 3 — Recorrido B, solo subtítulos

Horas previstas: 4.

- Conectar la captura elegida el día 1 al mismo adaptador, dirección `en→es`, sin síntesis.
- Mostrar subtítulos en un panel distinto, con borrado al detener.
- Repetir la prueba del tono: el texto del recorrido B no transcribe el audio del recorrido A.

Criterios de aceptación:

- Un audio inglés de prueba (WAV y, si el día 1 dejó la captura viva, la prueba de altavoz de Zoom) muestra subtítulos en español.
- Activar el recorrido A no inserta inglés sintético en los subtítulos.
- El cable de salida no recibe audio del recorrido B.
- Si Zoom no se pudo capturar el día 1, los criterios se cumplen con WAV y `tools/audio-windows.md` dice “recorrido B sin Zoom”.

### Día 4 — Ensayo en Zoom y recorte

Horas previstas: 4.

- Ensayo con auriculares: reunión de prueba (una sola cuenta o una segunda cuenta propia).
- Recorrido A: hablar español y escuchar el inglés en la prueba de micrófono de Zoom o en la segunda cuenta.
- Recorrido B: la otra voz en inglés produce subtítulos en español.
- Ajustar solo parámetros ya previstos (modelo ggml, umbral de voz, dispositivo). Sin funciones nuevas.
- Cerrar `tools/audio-windows.md` con latencias medidas, dispositivos y fallos conocidos.

Criterios de aceptación:

- Los dos recorridos funcionan en la misma sesión de Zoom, por separado y a la vez, sin que el cable devuelva la reunión hacia el micrófono de Zoom.
- Hay una cifra de latencia del recorrido A medida en ese ensayo.
- La lista de fallos conocidos cabe en una página e incluye permisos de micrófono, cambio de auriculares y el modo de audio de Zoom usado.
- Sigue sin cuentas, base de datos, pagos, clonación de voz, bot de reuniones y soporte de otras plataformas.

## Qué queda explícitamente para después del día 1

El día 1 no llama a Whisper, Argos ni Piper. Esos procesos se añaden el día 2, sobre un cable que ya demostró aislamiento.
