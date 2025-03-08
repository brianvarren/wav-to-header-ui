export default {
    async fetch(request: Request, env: any): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Only POST requests allowed", { status: 405 });
        }

        try {
            const formData = await request.formData();
            const files: File[] = [];

            for (const entry of formData.entries()) {
                const file = entry[1];
                if (file instanceof File) files.push(file);
            }

            if (files.length === 0) {
                return new Response("No valid WAV files uploaded", { status: 400 });
            }

            let headerFile = `#define NUM_SAMPLES ${files.length}\n\nstruct SampleData {\n`;
            headerFile += `    const uint16_t index;\n    const int16_t* data;\n    const uint32_t size;\n    const char* name;\n};\n\n`;

            let sampleDefinitions = `SampleData sample[NUM_SAMPLES] = {\n`;
            let sampleArrays = ``;
            
            let sampleIndex = 0;

            // UI Initialization: Add a dropdown menu to select PWM resolution
            const pwmResolutionSelect = document.createElement("select");
            pwmResolutionSelect.id = "pwmResolution";
            [12, 10, 8, 6].forEach(bits => {
                const option = document.createElement("option");
                option.value = bits.toString();
                option.textContent = `${bits}-bit PWM`;
                pwmResolutionSelect.appendChild(option);
            });
            document.body.appendChild(pwmResolutionSelect);

            function scaleSamples(samples: number[], bitDepth: number): number[] {
                const maxValue = (1 << bitDepth) - 1; // Max value for selected bit depth
                return samples.map(sample => Math.round(sample * maxValue / 4095)); // Scale from 12-bit default
            }

            pwmResolutionSelect.addEventListener("change", (event) => {
                const selectedBitDepth = parseInt((event.target as HTMLSelectElement).value, 10);
                scaledSamples = scaleSamples(originalSamples, selectedBitDepth);
                updatePlayback(); // Function to update playback with new values
            });

            for (const file of files) {
                const arrayBuffer = await file.arrayBuffer();
                const dataView = new DataView(arrayBuffer);
                const fileName = file.name.replace(".wav", "").replace(/\s+/g, "_");

                if (arrayBuffer.byteLength < 44) {
                    return new Response(`Error: ${file.name} is too short to be a valid WAV file.`, { status: 400 });
                }

                const riffHeader = new TextDecoder().decode(arrayBuffer.slice(0, 4));
                const waveHeader = new TextDecoder().decode(arrayBuffer.slice(8, 12));
                if (riffHeader !== "RIFF" || waveHeader !== "WAVE") {
                    return new Response(`Error: ${file.name} is not a valid WAV file.`, { status: 400 });
                }

                const sampleRate = dataView.getUint32(24, true);
                const numChannels = dataView.getUint16(22, true);
                const bitDepth = dataView.getUint16(34, true);

                let dataOffset = 12;
                let foundDataChunk = false;

                while (dataOffset < arrayBuffer.byteLength) {
                    const chunkId = new TextDecoder().decode(arrayBuffer.slice(dataOffset, dataOffset + 4));
                    const chunkSize = dataView.getUint32(dataOffset + 4, true);
                    if (chunkId.trim() === "data") {
                        dataOffset += 8;
                        foundDataChunk = true;
                        break;
                    }
                    dataOffset += 8 + chunkSize;
                }

                if (!foundDataChunk || dataOffset >= arrayBuffer.byteLength) {
                    return new Response(`Error: ${file.name} has no valid data chunk.`, { status: 400 });
                }

                const numSamples = (arrayBuffer.byteLength - dataOffset) / (bitDepth / 8) / numChannels;
                if (numSamples <= 0 || numSamples > 10000000) {
                    return new Response(`Error: ${file.name} contains invalid sample data.`, { status: 400 });
                }

                const samples = new Float32Array(numSamples);
                let peak = 0;

                for (let i = 0; i < numSamples; i++) {
                    let sampleValue = 0;
                    for (let ch = 0; ch < numChannels; ch++) {
                        const sampleIndex = dataOffset + (i * numChannels + ch) * (bitDepth / 8);
                        let sample = bitDepth === 16
                            ? dataView.getInt16(sampleIndex, true) / 32768
                            : dataView.getInt8(sampleIndex) / 128;
                        sampleValue += sample;
                    }
                    sampleValue /= numChannels;
                    samples[i] = sampleValue;
                    peak = Math.max(peak, Math.abs(sampleValue));
                }

                const scaledSamples = scaleSamples(samples, 12); // Default to 12-bit scaling

                sampleDefinitions += `    { ${sampleIndex}, &${fileName}[0], ${numSamples}, "${fileName}" },\n`;
                sampleArrays += `const int16_t ${fileName}[] PROGMEM = {\n`;
                for (let i = 0; i < scaledSamples.length; i++) {
                    sampleArrays += `${scaledSamples[i]}, `;
                    if (i % 10 === 9) sampleArrays += "\n";
                }
                sampleArrays += "};\n\n";

                sampleIndex++;
            }

            sampleDefinitions += "};\n\n";
            const fullHeaderFile = headerFile + sampleDefinitions + sampleArrays;

            return new Response(fullHeaderFile, {
                status: 200,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Disposition": `attachment; filename="converted_samples.h"`,
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            });

        } catch (error) {
            console.error("Worker Error:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    },
};
