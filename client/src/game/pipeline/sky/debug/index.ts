/**
 * Sky Debug Interface
 * 
 * Provides debug controls for the sky system, allowing switching between
 * different sky rendering methods and toggling sky visibility.
 */

class SkyDebug {
  private skyManager: any;
  private isInitialized: boolean = false;

  constructor(skyManager: any) {
    this.skyManager = skyManager;
    this.initialize();
  }

  private initialize(): void {
    if (this.isInitialized) return;
    
    // Add debug controls to the global window object for easy access
    (window as any).skyDebug = {
      setMethod: (method: 'cone' | 'procedural' | 'skybox') => {
        console.log(`Switching sky method to: ${method}`);
        this.skyManager.setMethod(method);
      },
      
      toggleSky: () => {
        const enabled = this.skyManager.isSkyEnabled();
        console.log(`Toggling sky: ${enabled ? 'OFF' : 'ON'}`);
        this.skyManager.setEnabled(!enabled);
      },
      
      getMethod: () => {
        const method = this.skyManager.getMethod();
        console.log(`Current sky method: ${method}`);
        return method;
      },
      
      isEnabled: () => {
        const enabled = this.skyManager.isSkyEnabled();
        console.log(`Sky enabled: ${enabled}`);
        return enabled;
      },
      
      help: () => {
        console.log('Sky Debug Commands:');
        console.log('  skyDebug.setMethod("cone") - Use Blizzard sky cone method');
        console.log('  skyDebug.setMethod("procedural") - Use procedural sphere method');
        console.log('  skyDebug.setMethod("skybox") - Use traditional skybox method');
        console.log('  skyDebug.toggleSky() - Toggle sky visibility');
        console.log('  skyDebug.getMethod() - Get current sky method');
        console.log('  skyDebug.isEnabled() - Check if sky is enabled');
        console.log('  skyDebug.debugInfo() - Show detailed sky debug info');
        console.log('  skyDebug.testSky() - Create a test red wireframe sphere');
        console.log('  skyDebug.createTestCube() - Create a simple red test cube');
        console.log('  skyDebug.addTestCubeAtPlayer() - Add green cube at player position +20');
        console.log('  skyDebug.addSimpleSkybox() - Add simple black skybox using same method');
        console.log('  skyDebug.tryLoadMDX() - Try to load MDX skybox file');
        console.log('  skyDebug.forceSkyVisible() - Force all sky objects to be visible');
        console.log('  skyDebug.forceReinit() - Force reinitialize sky system');
        console.log('  skyDebug.checkScene() - List all objects in scene');
        console.log('  skyDebug.showPositions() - Show sky and camera positions');
        console.log('  skyDebug.help() - Show this help');
      },
      
      debugInfo: () => {
        const method = this.skyManager.getMethod();
        const enabled = this.skyManager.isSkyEnabled();
        const currentSky = this.skyManager.getCurrentSky();
        console.log('=== Sky Debug Info ===');
        console.log(`Method: ${method}`);
        console.log(`Enabled: ${enabled}`);
        console.log(`Current sky object: ${currentSky ? currentSky.name : 'null'}`);
        console.log(`Scene children count: ${this.skyManager.scene.children.length}`);
        
        // Find sky objects in scene
        const skyObjects = this.skyManager.scene.children.filter((child: any) => 
          child.name === 'SkyCone' || child.name === 'ProceduralSky' || child.name === 'Skybox'
        );
        console.log(`Sky objects in scene: ${skyObjects.length}`);
        
        skyObjects.forEach((sky: any, index: number) => {
          console.log(`  Sky ${index + 1}: ${sky.name}`);
          console.log(`    Visible: ${sky.visible}`);
          console.log(`    Position: (${sky.position.x.toFixed(2)}, ${sky.position.y.toFixed(2)}, ${sky.position.z.toFixed(2)})`);
          console.log(`    RenderOrder: ${sky.renderOrder}`);
          console.log(`    FrustumCulled: ${sky.frustumCulled}`);
        });
      },
      
      testSky: () => {
        console.log('Creating test sky sphere...');
        const THREE = (window as any).THREE;
        const geometry = new THREE.SphereGeometry(100, 16, 16);
        const material = new THREE.MeshBasicMaterial({ 
          color: 0xff0000, 
          side: THREE.BackSide,
          wireframe: true 
        });
        const testSky = new THREE.Mesh(geometry, material);
        testSky.name = 'TestSky';
        testSky.position.set(0, 0, 0);
        testSky.renderOrder = -1000;
        testSky.frustumCulled = false;
        
        this.skyManager.scene.add(testSky);
        console.log('Test sky added to scene');
        
        // Remove it after 5 seconds
        setTimeout(() => {
          this.skyManager.scene.remove(testSky);
          console.log('Test sky removed');
        }, 5000);
      },
      
      forceReinit: () => {
        console.log('Force reinitializing sky...');
        this.skyManager.initialize(this.skyManager.getMethod());
        console.log('Sky reinitialized');
      },
      
      checkScene: () => {
        console.log('=== Scene Check ===');
        console.log(`Scene children: ${this.skyManager.scene.children.length}`);
        this.skyManager.scene.children.forEach((child: any, index: number) => {
          console.log(`  ${index}: ${child.name} (${child.type})`);
        });
      },
      
      showPositions: () => {
        console.log('=== Position Info ===');
        const currentSky = this.skyManager.getCurrentSky();
        if (currentSky) {
          console.log(`Sky position: (${currentSky.position.x.toFixed(2)}, ${currentSky.position.y.toFixed(2)}, ${currentSky.position.z.toFixed(2)})`);
          console.log(`Sky visible: ${currentSky.visible}`);
          console.log(`Sky renderOrder: ${currentSky.renderOrder}`);
        } else {
          console.log('No sky object found');
        }
        
        // Try to get camera position from the world
        if ((window as any).world && (window as any).world.game && (window as any).world.game.camera) {
          const camera = (window as any).world.game.camera;
          console.log(`Camera position: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`);
        } else {
          console.log('Camera position not available');
        }
      },
      
      createTestCube: () => {
        console.log('Creating a simple test cube...');
        const THREE = (window as any).THREE;
        const geometry = new THREE.BoxGeometry(100, 100, 100);
        const material = new THREE.MeshBasicMaterial({ 
          color: 0xff0000, // Bright red
          side: THREE.BackSide,
          wireframe: true 
        });
        const testCube = new THREE.Mesh(geometry, material);
        testCube.name = 'TestCube';
        testCube.position.set(0, 0, 0);
        testCube.renderOrder = -1000;
        testCube.frustumCulled = false;
        
        this.skyManager.scene.add(testCube);
        console.log('Test cube added to scene');
        
        // Remove it after 10 seconds
        setTimeout(() => {
          this.skyManager.scene.remove(testCube);
          console.log('Test cube removed');
        }, 10000);
      },
      
      forceSkyVisible: () => {
        console.log('Forcing all sky objects to be visible...');
        const skyObjects = this.skyManager.scene.children.filter((child: any) => 
          child.name === 'SkyCone' || child.name === 'ProceduralSky' || child.name === 'Skybox'
        );
        
        skyObjects.forEach((sky: any) => {
          sky.visible = true;
          sky.frustumCulled = false;
          console.log(`Forced ${sky.name} to be visible`);
        });
        
        console.log(`Forced ${skyObjects.length} sky objects to be visible`);
      },
      
      addTestCubeAtPlayer: () => {
        console.log('Adding test cube at player position +20...');
        const THREE = (window as any).THREE;
        
        // Get player position
        let playerPos = new THREE.Vector3(0, 0, 0);
        if ((window as any).world && (window as any).world.player) {
          playerPos = (window as any).world.player.position.clone();
          console.log(`Player position: (${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)})`);
        }
        
        // Create test cube
        const geometry = new THREE.BoxGeometry(10, 10, 10);
        const material = new THREE.MeshBasicMaterial({ 
          color: 0x00ff00, // Bright green
          wireframe: false 
        });
        const testCube = new THREE.Mesh(geometry, material);
        testCube.name = 'PlayerTestCube';
        
        // Position at player + 20 units up
        testCube.position.set(playerPos.x, playerPos.y + 20, playerPos.z);
        testCube.renderOrder = 1000; // Render after everything else
        testCube.frustumCulled = false;
        
        this.skyManager.scene.add(testCube);
        console.log(`Test cube added at: (${testCube.position.x.toFixed(2)}, ${testCube.position.y.toFixed(2)}, ${testCube.position.z.toFixed(2)})`);
        
        // Remove it after 30 seconds
        setTimeout(() => {
          this.skyManager.scene.remove(testCube);
          console.log('Player test cube removed');
        }, 30000);
      },
      
      addSimpleSkybox: () => {
        console.log('Adding small skybox cube near player for testing...');
        const THREE = (window as any).THREE;
        
        // Get player position
        let playerPos = new THREE.Vector3(0, 0, 0);
        if ((window as any).world && (window as any).world.player) {
          playerPos = (window as any).world.player.position.clone();
          console.log(`Player position: (${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)})`);
        }
        
        // Create small skybox cube for testing - 50 units size
        const geometry = new THREE.BoxGeometry(50, 50, 50);
        const material = new THREE.MeshBasicMaterial({ 
          color: 0x000000, // Black
          side: THREE.DoubleSide,
          wireframe: false 
        });
        const skybox = new THREE.Mesh(geometry, material);
        skybox.name = 'SmallSkybox';
        
        // Position near player (10 units to the side)
        skybox.position.set(playerPos.x + 10, playerPos.y, playerPos.z);
        
        // Apply the same rotation as the working implementation
        skybox.rotation.set(
          -Math.PI / 2,
          Math.PI,
          Math.PI,
        );
        
        skybox.renderOrder = -1000; // Render before everything else
        skybox.frustumCulled = false;
        
        this.skyManager.scene.add(skybox);
        console.log(`Small skybox added at: (${skybox.position.x.toFixed(2)}, ${skybox.position.y.toFixed(2)}, ${skybox.position.z.toFixed(2)})`);
        console.log(`Skybox rotation: (${skybox.rotation.x.toFixed(2)}, ${skybox.rotation.y.toFixed(2)}, ${skybox.rotation.z.toFixed(2)})`);
        console.log('Look to the side to see the small black cube!');
        
        // Remove it after 30 seconds
        setTimeout(() => {
          this.skyManager.scene.remove(skybox);
          console.log('Small skybox removed');
        }, 30000);
      },
      
      tryLoadMDX: async () => {
        console.log('Attempting to load MDX skybox...');
        
        try {
          // Load LightSkybox DBC to get MDX file path
          const DBC = (window as any).DBC;
          const lightSkyboxDBC = await DBC.load('LightSkybox');
          const skyboxRecord = lightSkyboxDBC[1]; // Use ID 1 which has the MDX file
          
          if (!skyboxRecord) {
            console.error('No skybox record found for ID 1');
            return;
          }
          
          console.log(`Found MDX file: ${skyboxRecord.file}`);
          
          // Check if there's an MDX loader available
          if ((window as any).MDXLoader) {
            console.log('MDXLoader found, attempting to load...');
            // This would require an MDX loader implementation
            console.log('MDX loading not yet implemented');
          } else {
            console.log('No MDXLoader available. MDX files require special handling.');
            console.log('Options:');
            console.log('1. Use a Three.js MDX loader library');
            console.log('2. Convert MDX to OBJ/GLTF format');
            console.log('3. Extract textures from MDX and use as skybox');
            console.log('4. Use the MDX as a 3D skybox model instead of cube');
          }
          
        } catch (error) {
          console.error('Failed to load MDX skybox:', error);
        }
      }
    };

    this.isInitialized = true;
    console.log('Sky debug interface initialized. Use skyDebug.help() for commands.');
  }

  public dispose(): void {
    if ((window as any).skyDebug) {
      delete (window as any).skyDebug;
    }
    this.isInitialized = false;
  }
}

export default SkyDebug;
