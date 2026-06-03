@echo off
chcp 65001 > nul
echo ============================================
echo  Instalando Monitor NFSe -- RJ Logistica
echo ============================================

set "SCRIPT=F:\Arquivos Academicos\Jarvis\Material para Aula\Documents and Projects\emissor-de-notas\monitorar-nfse.cjs"
set TASKNAME=MonitorNFSe-RJLogistica

for /f "delims=" %%i in ('where node') do set NODEPATH=%%i

echo Node.js: %NODEPATH%
echo Script: %SCRIPT%
echo.

schtasks /delete /tn "%TASKNAME%" /f 2>nul

schtasks /create /tn "%TASKNAME%" /tr "\"%NODEPATH%\" \"%SCRIPT%\"" /sc daily /st 08:00 /ru SYSTEM /f

if %errorlevel% == 0 (
  echo.
  echo [OK] Tarefa agendada com sucesso!
  echo      Roda todos os dias as 08:00
  echo      Notifica quando RJ liberar NFSe para Simples Nacional
  echo.
  echo Para testar agora execute no CMD como Admin:
  echo   schtasks /run /tn "%TASKNAME%"
  echo.
  echo Para ver o log:
  echo   notepad "%~dp0logs\monitor-nfse.log"
) else (
  echo.
  echo [ERRO] Falha ao criar tarefa. Execute este arquivo como Administrador.
)

pause
