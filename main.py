import os
import shutil
import uuid
import zipfile
import xml.etree.ElementTree as ET
from typing import Dict
from io import BytesIO

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI()

# Configurar carpeta temporal y estática
TEMP_DIR = os.path.join(BASE_DIR, "temp_files")
STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(TEMP_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def read_root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# ─────────────────────────────────────────────────────────────────────────────
# Helpers para manipular el PPTX como ZIP + XML directamente
# ─────────────────────────────────────────────────────────────────────────────

def _get_rels_files(zf: zipfile.ZipFile):
    """Devuelve todos los archivos .rels dentro del ZIP."""
    return [name for name in zf.namelist() if name.endswith('.rels')]


def extract_links_from_pptx(filepath: str) -> list:
    """
    Extrae todos los enlaces externos (Target con TargetMode=External)
    que estén en los archivos .rels del PPTX.
    """
    links = set()
    ns = 'http://schemas.openxmlformats.org/package/2006/relationships'

    with zipfile.ZipFile(filepath, 'r') as zf:
        for rels_file in _get_rels_files(zf):
            try:
                content = zf.read(rels_file)
                root = ET.fromstring(content)
                for rel in root.findall(f'{{{ns}}}Relationship'):
                    target_mode = rel.get('TargetMode', '')
                    target = rel.get('Target', '')
                    if target_mode == 'External' and target:
                        # Ignorar URLs http/https, nos quedamos con rutas de archivos
                        if not target.startswith('http://') and not target.startswith('https://'):
                            # Decodificar %20 y similares para mostrarlo limpio
                            from urllib.parse import unquote
                            links.add(unquote(target))
            except Exception:
                pass

    return list(links)


def update_links_in_pptx(src_filepath: str, dest_filepath: str, updates: Dict[str, str]):
    """
    Crea una copia del PPTX con los enlaces externos actualizados
    directamente en los archivos .rels, sin abrir PowerPoint.
    updates: {ruta_vieja: ruta_nueva}
    """
    from urllib.parse import unquote, quote

    ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
    ET.register_namespace('', ns)

    # Construir mapa normalizado (por si las rutas en el XML están codificadas)
    normalized_updates = {}
    for old, new in updates.items():
        normalized_updates[old] = new
        normalized_updates[quote(old, safe='/:@!$&\'()*+,;=')] = quote(new, safe='/:@!$&\'()*+,;=')

    with zipfile.ZipFile(src_filepath, 'r') as zf_in:
        with zipfile.ZipFile(dest_filepath, 'w', compression=zipfile.ZIP_DEFLATED) as zf_out:
            for item in zf_in.infolist():
                data = zf_in.read(item.filename)

                if item.filename.endswith('.rels'):
                    try:
                        root = ET.fromstring(data)
                        modified = False

                        for rel in root.findall(f'{{{ns}}}Relationship'):
                            target_mode = rel.get('TargetMode', '')
                            target = rel.get('Target', '')

                            if target_mode == 'External' and target:
                                from urllib.parse import unquote as _unquote
                                decoded_target = _unquote(target)

                                # Buscar si la ruta base coincide con alguna actualización
                                for old_base, new_base in updates.items():
                                    if decoded_target.startswith(old_base) or target.startswith(old_base):
                                        # Reemplazar la ruta base preservando el resto (ej: !Hoja1!...)
                                        new_target = decoded_target.replace(old_base, new_base, 1)
                                        rel.set('Target', new_target)
                                        modified = True
                                        break

                        if modified:
                            data = ET.tostring(root, encoding='unicode', xml_declaration=False).encode('utf-8')
                            # Asegurar declaración XML
                            if not data.startswith(b'<?xml'):
                                data = b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n" + data
                    except Exception:
                        pass  # Si falla el parseo, se guarda el original sin cambios

                zf_out.writestr(item, data)


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/analyze")
async def analyze_ppt(file: UploadFile = File(...)):
    if not file.filename.endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only .pptx files are allowed")

    unique_id = str(uuid.uuid4())
    temp_filename = f"{unique_id}_{file.filename}"
    temp_filepath = os.path.join(TEMP_DIR, temp_filename)

    with open(temp_filepath, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        links = extract_links_from_pptx(temp_filepath)
        return JSONResponse({"filename": temp_filename, "links": links})
    except Exception as e:
        os.remove(temp_filepath)
        raise HTTPException(status_code=500, detail=str(e))


class UpdateRequest(BaseModel):
    filename: str
    updates: Dict[str, str]


def remove_file(path: str):
    try:
        os.remove(path)
    except Exception:
        pass


@app.post("/api/update")
async def update_ppt(request: UpdateRequest, background_tasks: BackgroundTasks):
    src_filepath = os.path.join(TEMP_DIR, request.filename)
    if not os.path.exists(src_filepath):
        raise HTTPException(status_code=404, detail="File not found")

    # Archivo de salida distinto para no sobrescribir el original mientras se lee
    out_filename = f"out_{request.filename}"
    dest_filepath = os.path.join(TEMP_DIR, out_filename)

    try:
        update_links_in_pptx(src_filepath, dest_filepath, request.updates)

        # Programar limpieza de ambos archivos tras la descarga
        background_tasks.add_task(remove_file, src_filepath)
        background_tasks.add_task(remove_file, dest_filepath)

        # Nombre amigable para la descarga
        orig_name = request.filename.split("_", 2)[-1] if "_" in request.filename else "presentacion.pptx"

        return FileResponse(
            path=dest_filepath,
            filename=f"Modificada_{orig_name}",
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )
    except Exception as e:
        remove_file(dest_filepath)
        raise HTTPException(status_code=500, detail=str(e))
