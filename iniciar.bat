@echo off
echo Iniciando la aplicacion web...
echo Abriendo el navegador en http://127.0.0.1:8000

:: Espera 2 segundos antes de abrir el navegador para dar tiempo a que el servidor inicie
timeout /t 2 /nobreak > NUL
start http://127.0.0.1:8000

:: Inicia el servidor de FastAPI
python -m uvicorn main:app
pause
