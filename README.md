# Control por voz (plugin de NOPAL)

Di «Nopal» y controla el taller con la voz, desde el navegador. Solo frontend, sin Python ni servicios aparte.

## Qué hace
- Luces y aire (escenas de Accesorios): «enciende la luz», «apaga el aire».
- Máquinas: «¿cómo va todo?», «¿qué está trabajando?», «haz home», «pausa / reanuda la impresión», «cancela la impresión».
- Calentar y mover: «precalienta para PLA», «calienta el extrusor a 220 y la cama a 70» (topes 280/110 °C), «sube el cabezal 10 mm», «encuadra».
- Reportes: filamento (Spoolman), estado del sistema, alertas, archivos, temperatura y humedad del taller, sensores.
- Tiras LED: «alerta roja / amarilla / verde / azul» y «cancela la alerta»; «pon el aro en verde».
- Cotizaciones: «crea una cotización para 20 llaveros de 5 por 5 en MDF 3 mm para el cliente Juan» (lámina por m², queda como cotización en el Cotizador).
- Pantalla: «abre configuración», «ve al cotizador», «abre la ficha de la impresora», «cambia el tema», «cierra la ventana», «regresa».
- Avisos solos (con NOPAL abierto): impresión terminada, temperatura alcanzada, alarma de láser, impresora en error, servicio caído, taller muy caliente o húmedo, y máquina parada con trabajo en su cola («¿la arranco?»). «No me molestes por 2 horas» los silencia.
- Recordatorios simples (`en 20 minutos`, `a las 5 de la tarde`).
- Todo lo demás se le pregunta a la IA de NOPAL (si la tienes configurada).

**Seguridad:** todo lo que mueve algo pide confirmación («di sí o no»): cancelar impresión, mover Z, encuadrar, guardar cotización, arrancar cola. Home, pausa y movimientos se niegan si la máquina está imprimiendo.

## Cómo funciona
Corre en tu navegador con **tu sesión de NOPAL**: no guarda contraseñas ni crea usuarios. Solo puede hacer lo que tu usuario ya puede hacer. Los ajustes (apodos, voz, escenas por defecto) se guardan en este navegador.

## Requisitos
- Microsoft Edge o Google Chrome (Brave y Firefox no traen reconocimiento de voz).
- **HTTPS o `localhost`**: el navegador solo da el micrófono en contextos seguros. Si abres NOPAL por `http://IP:8420`, la sección te lo avisará. Solución: poner NOPAL detrás de un proxy inverso con HTTPS (ver «Red y HTTPS» en la documentación de NOPAL).
- El reconocimiento de voz de Edge/Chrome usa los servidores del navegador (necesita internet).

## Instalar
1. Entrada en `backend/plugin_catalog.json` del core (ver `docs/catalog-entry.json`).
2. Configuración → Galería de plugins → Control por voz → Instalar.

Para desarrollar sin la Galería: copia esta carpeta a `plugins/control-por-voz/`, añádelo a `data/plugins/installed.json` y agrega la entrada de catálogo. No necesita reiniciar (no tiene backend).

## Pruebas
```
node --test tests/
```
Usan un NOPAL simulado; no tocan hardware.

## Límites
- Los avisos y recordatorios solo funcionan mientras NOPAL esté abierto en el navegador (cada navegador avisa por su cuenta).
- Las cotizaciones por voz aún no entienden fecha de entrega ni crean su recordatorio.
- Sin apodos aprendidos solos ni comandos propios (`comandos.json`) ni apodos cariñosos («capitán»): los apodos de máquinas y escenas se escriben en la sección del plugin.

## Pendiente (módulo opcional del taller)
Bocina con alertas sonoras (sirena, volumen, Booster), oído sin internet (Vosk), voz Piper y aro azul al escuchar. Requieren una máquina con tarjeta de sonido y no caben en un plugin de navegador.
