const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

async function generateIcons() {
  const svgPath = path.join(__dirname, '../assets/icon.svg');
  const pngPath = path.join(__dirname, '../assets/icon.png');
  const icoPath = path.join(__dirname, '../assets/icon.ico');
  
  const svgBuffer = fs.readFileSync(svgPath);

  console.log('Generating icons from SVG...');

  try {
    // Generate PNG at 256x256 (standard size for Windows icons)
    await sharp(svgBuffer)
      .resize(256, 256)
      .png()
      .toFile(pngPath);
    console.log('✓ Generated icon.png (256x256)');

    // Generate multiple PNG sizes for ICO
    const sizes = [16, 32, 48, 64, 128, 256];
    const tempDir = path.join(__dirname, '../assets/temp');
    
    // Create temp directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const pngPaths = [];
    for (const size of sizes) {
      const tempPath = path.join(tempDir, `icon-${size}.png`);
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(tempPath);
      pngPaths.push(tempPath);
      console.log(`  Generated ${size}x${size} PNG`);
    }

    // Convert PNGs to ICO
    console.log('\nGenerating ICO file...');
    const icoBuffer = await pngToIco(pngPaths);
    fs.writeFileSync(icoPath, icoBuffer);
    console.log('✓ Generated icon.ico (multi-resolution)');
    
    // Clean up temp files
    pngPaths.forEach(p => fs.unlinkSync(p));
    fs.rmdirSync(tempDir);
    
    console.log('\n✅ All icons generated successfully!');
    
  } catch (error) {
    console.error('❌ Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
