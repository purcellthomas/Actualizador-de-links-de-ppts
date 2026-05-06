document.addEventListener('DOMContentLoaded', () => {
    // Referencias a DOM
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const uploadStatus = document.getElementById('upload-status');
    const updateStatus = document.getElementById('update-status');
    const linksList = document.getElementById('links-list');
    const linksCount = document.getElementById('links-count');
    
    // Botones
    const applyGlobalBtn = document.getElementById('apply-global-btn');
    const backBtn = document.getElementById('back-btn');
    const submitBtn = document.getElementById('submit-btn');
    
    // Inputs globales
    const findInput = document.getElementById('find-input');
    const replaceInput = document.getElementById('replace-input');

    let currentFilename = '';
    let originalLinks = [];

    // Helper para obtener la ruta base del archivo
    function getBasePath(link) {
        return link.split('!')[0];
    }

    // --- MANEJO DE DRAG & DROP ---
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            handleFileUpload(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileUpload(e.target.files[0]);
        }
    });

    // --- LÓGICA DE SUBIDA (Paso 1 a 2) ---
    async function handleFileUpload(file) {
        if (!file.name.endsWith('.pptx')) {
            alert('Por favor selecciona un archivo .pptx válido.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        uploadStatus.classList.remove('hidden');
        dropZone.style.opacity = '0.5';
        dropZone.style.pointerEvents = 'none';

        try {
            const response = await fetch('/api/analyze', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Error al analizar el archivo');
            
            const data = await response.json();
            currentFilename = data.filename;
            originalLinks = data.links;
            
            renderLinks(originalLinks);
            
            // Pasar al paso 2
            step1.classList.remove('active');
            step1.classList.add('hidden');
            step2.classList.remove('hidden');
            step2.classList.add('active');

        } catch (error) {
            alert(error.message);
        } finally {
            uploadStatus.classList.add('hidden');
            dropZone.style.opacity = '1';
            dropZone.style.pointerEvents = 'auto';
            fileInput.value = ''; // reset
        }
    }

    // --- RENDERIZADO DE LINKS ---
    function renderLinks(links) {
        // Agrupar por basePath
        const groups = {};
        links.forEach(link => {
            const basePath = getBasePath(link);
            if (!groups[basePath]) {
                groups[basePath] = [];
            }
            groups[basePath].push(link);
        });

        const numGroups = Object.keys(groups).length;
        linksCount.textContent = `${numGroups} archivo(s) origen (de ${links.length} enlaces)`;
        linksList.innerHTML = '';
        
        if (links.length === 0) {
            linksList.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 2rem;">No se encontraron enlaces en esta presentación.</p>';
            return;
        }

        Object.keys(groups).forEach(basePath => {
            const groupLinks = groups[basePath];
            const card = document.createElement('div');
            card.className = 'link-card';
            card.innerHTML = `
                <div class="link-old" style="margin-bottom: 8px;">
                    <span class="label">Archivo Origen (${groupLinks.length} enlace${groupLinks.length > 1 ? 's' : ''}):</span>
                    <span class="path" title="${basePath}">${basePath}</span>
                </div>
                <div class="link-new">
                    <span class="label">Nueva Ruta del Archivo:</span>
                    <input type="text" class="new-link-input" data-original-base="${basePath}" value="${basePath}">
                </div>
            `;
            linksList.appendChild(card);
        });
    }

    // --- BUSCAR Y REEMPLAZAR GLOBAL ---
    applyGlobalBtn.addEventListener('click', () => {
        const findText = findInput.value;
        const replaceText = replaceInput.value;
        
        if (!findText) return;

        const inputs = document.querySelectorAll('.new-link-input');
        inputs.forEach(input => {
            // Reemplaza en el texto que hay actualmente en la caja de texto
            input.value = input.value.split(findText).join(replaceText);
        });
    });

    // --- VOLVER ATRÁS ---
    backBtn.addEventListener('click', () => {
        step2.classList.remove('active');
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
        step1.classList.add('active');
        findInput.value = '';
        replaceInput.value = '';
    });

    // --- ENVIAR CAMBIOS (Paso 2 a Final) ---
    submitBtn.addEventListener('click', async () => {
        const inputs = document.querySelectorAll('.new-link-input');
        const updates = {};
        
        inputs.forEach(input => {
            const originalBase = input.getAttribute('data-original-base');
            const currentBase = input.value;
            
            // Solo mandamos si realmente cambió la ruta base
            if (originalBase !== currentBase) {
                // Encontrar todos los links originales que pertenecen a este grupo
                const groupLinks = originalLinks.filter(link => getBasePath(link) === originalBase);
                groupLinks.forEach(link => {
                    // Reemplazar solo la parte base en el enlace completo
                    updates[link] = link.replace(originalBase, currentBase);
                });
            }
        });

        if (Object.keys(updates).length === 0) {
            alert('No has realizado ningún cambio en los enlaces.');
            return;
        }

        submitBtn.disabled = true;
        backBtn.disabled = true;
        updateStatus.classList.remove('hidden');

        try {
            const response = await fetch('/api/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    filename: currentFilename,
                    updates: updates
                })
            });

            if (!response.ok) throw new Error('Error al actualizar el archivo');

            // Manejar la descarga del archivo binario
            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            
            // Extraer nombre del content-disposition si existe, o generar uno
            const disposition = response.headers.get('content-disposition');
            let filename = `Modificada_${currentFilename.split('_')[1]}`;
            if (disposition && disposition.indexOf('filename=') !== -1) {
                const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
                if (matches != null && matches[1]) {
                    filename = matches[1].replace(/['"]/g, '');
                }
            }
            
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(downloadUrl);
            a.remove();
            
            // Éxito: volver a inicio
            alert('¡Archivo actualizado y descargado con éxito!');
            backBtn.click();
            
        } catch (error) {
            alert(error.message);
        } finally {
            submitBtn.disabled = false;
            backBtn.disabled = false;
            updateStatus.classList.add('hidden');
        }
    });
});
