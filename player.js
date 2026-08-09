class Player {
    constructor(scene, camera, keys) {
        this.scene = scene;
        this.camera = camera;
        this.keys = keys;
        
        this.healthFill = document.getElementById('health-bar-fill');
        this.crosshair = document.getElementById('crosshair');

        this.spawnPoint = new THREE.Vector3(0, 5, 0);
        this.isRespawning = false;
        this.isDead = false;
        this.isSitting = false;
        this.isClimbing = false;
        this.onGround = true;
        this.qKeyWasPressed = false;
        // Analog movement input (set by gamepad code in studio.html): {x, y} each -1..1,
        // x = strafe (right positive), y = raw stick Y (up/forward is negative). When set
        // and non-zero, this drives movement instead of the digital WASD keys below, giving
        // full 360-degree direction and speed proportional to how far the stick is pushed.
        this.analogMove = null;
        // Separate from this.keys[' '] so gamepad polling never has to touch/clobber real
        // keyboard key state (keys[' '] is toggled by its own keydown/keyup listeners).
        this.gamepadJump = false;
        this.currentVelocity = new THREE.Vector3(0, 0, 0);
        this.velocityY = 0;
        this.isJumping = false;
this.walkCycle = 0;
        this.groundY = 0; 
        this.hipHeight = 0;
        this.velX = 0;
        this.velZ = 0;
        this.floorMaterial = 'Plastic';
        this.isPlatformStand = false;
        this.isPhysicsLocked = false; 
        this.isGettingUp = false;     

        // --- Landed / Climbing / Swimming (Roblox Humanoid states) ---
        this.isSwimming = false;   // reserved for future water volumes
        this.isLanded = false;     // brief transient state fired on touchdown

        // --- Shift Lock camera (toggle, offsets camera 1.75 studs right of head) ---
        this.shiftLock = false;
        this.shiftKeyWasPressed = false;

        // --- First person / close-zoom fade state (read by studio.html for accessories) ---
        this.isFirstPerson = false;
        this.zoomFadeAlpha = 1;

        // --- Emotes (/e wave, point, dance, dance2, dance3, laugh, cheer) ---
        this.emoteName = null;
        this.emoteStartTime = 0;

        // --- Idle animation variation (Idle / Idle1 / Idle2 style subtle sway) ---
        this.idleSeed = Math.random() * 1000;

        // --- 2016-style camera zoom (multiplicative, not fixed-stud) ---
        this.minZoom = 0.5;
        this.maxZoom = 128;
        this._pendingZoomFactor = 1;
        this._camRaycaster = new THREE.Raycaster();

        if (this.camera) {
            this.camera.fov = 70; // Roblox 2016 default FOV
            if (this.camera.updateProjectionMatrix) this.camera.updateProjectionMatrix();
        }

        // Mouse wheel = exponential zoom, matching the old CameraModule (x0.9 in / x1.1 out per notch)
        this._wheelHandler = (e) => {
            const target = e.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
            const notches = Math.min(Math.abs(e.deltaY) / 100, 3);
            const factor = Math.pow(e.deltaY > 0 ? 1.1 : 0.9, notches);
            this._pendingZoomFactor *= factor;
        };
        window.addEventListener('wheel', this._wheelHandler);

        this.walkSpeed = 16 / 60; 
        this.jumpPower = 53.15 / 60; // 7.2 Stud Jump exact velocity
        this.gravity = 196.2 / (60 * 60); 

        this.healthInterval = setInterval(() => {
            if (!this.isDead && this.humanoidId) {
                let hp = window.EngineAPI.getProperty(this.humanoidId, "Health");
                if (hp < 100 && hp > 0) {
                    window.EngineAPI.setProperty(this.humanoidId, "Health", Math.min(100, hp + 1));
                }
                // Previously this only ran (and only ever called updateHealthBar) when
                // 0 < hp < 100, which meant hp === 0 was never re-checked here at all.
                // Call it unconditionally so death is always caught, even as a fallback
                // if the immediate reactive check on the Health property set is missed.
                this.updateHealthBar();
            }
        }, 1000);

        this.respawnPlayer();
    }

    updateHealthBar() {
        if (!this.humanoidId) return;
        let hp = window.EngineAPI.getProperty(this.humanoidId, "Health");
        let percentage = Math.max(0, hp);
        this.healthFill.style.width = percentage + '%';
        
        if (percentage > 50) this.healthFill.style.backgroundColor = '#00FF00';
        else if (percentage > 20) this.healthFill.style.backgroundColor = '#FFFF00';
        else this.healthFill.style.backgroundColor = '#FF0000';

        if (hp <= 0 && !this.isDead) this.die();
    }

    sit(seatBlock) {
        if (this.isDead || !this.torso) return;
        this.isSitting = true;
        this.isJumping = false;
        
        if (seatBlock) {
            const seatPos = new THREE.Vector3();
            seatBlock.getWorldPosition(seatPos);
            this.torso.position.set(seatPos.x, seatPos.y + seatBlock.scale.y + 2.0, seatPos.z);
            if (seatBlock.rotation) this.torso.rotation.y = seatBlock.rotation.y;
        }
    }

    die() {
        if (this.isDead) return;
        this.isDead = true;
        this.isSitting = false;
        this.isClimbing = false;
        window.EngineAPI.setProperty(this.humanoidId, "Health", 0);
        this.updateHealthBar();
        
        let s = window.non3DItems.find(i => i.parent === this.hrpId && i.name === "Died");
        if (s && s.SoundId) { let a = new Audio(s.SoundId); a.volume = s.Volume || 1; a.play().catch(()=>{}); }

        const breakJoints = window.EngineAPI.getProperty(this.humanoidId, "BreakJointsOnDeath") !== false;
        if (breakJoints) {
            [this.neckId, this.lsId, this.rsId, this.lhId, this.rhId, this.rootJointId].forEach(weldId => {
                window.EngineAPI.setProperty(weldId, "Part0", null);
            });
        }

        [this.head, this.torso, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg, this.hrp].forEach(part => {
            if (part) {
                part.userData.canCollide = true;
                part.userData.isPlayerPart = false; 
                part.userData.vel = this.currentVelocity.clone().add(new THREE.Vector3(
                    (Math.random() - 0.5) * 0.2, Math.random() * 0.2, (Math.random() - 0.5) * 0.2
                ));
                part.userData.rotVel = new THREE.Vector3(
                    (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2
                );
            }
        });

        setTimeout(() => this.respawnPlayer(), 5000);
    }

    respawnPlayer() {
        if (!this.scene) return;
        if (this.playerId) window.EngineAPI.destroyInstance(this.playerId);

        this.isDead = false;
        this.isRespawning = true;
        this.isSitting = false;
        this.isClimbing = false;
        this.onGround = true;
        
let uDataName = {};
        try { uDataName = JSON.parse(localStorage.getItem('userData') || '{}'); } catch(e) {}
        const playerName = uDataName.username || "Player1";

        this.playerId = window.EngineAPI.instanceNew("Model", "Workspace");
        window.EngineAPI.setProperty(this.playerId, "Name", playerName);

        if (window.luaDispatcher && window.localPlayerId) {
            setTimeout(() => {
                if (window.luaDispatcher) window.luaDispatcher(window.localPlayerId, "CharacterAdded", this.playerId);
            }, 100);
        }

        this.humanoidId = window.EngineAPI.instanceNew("Humanoid", this.playerId);
        window.EngineAPI.setProperty(this.humanoidId, "Health", 100);
        window.EngineAPI.setProperty(this.humanoidId, "MaxHealth", 100);
        window.EngineAPI.setProperty(this.humanoidId, "WalkSpeed", 16);
        window.EngineAPI.setProperty(this.humanoidId, "JumpPower", 50);
        window.EngineAPI.setProperty(this.humanoidId, "UseJumpPower", true);
        window.EngineAPI.setProperty(this.humanoidId, "Sit", false);
        window.EngineAPI.setProperty(this.humanoidId, "Jump", false);
        window.EngineAPI.setProperty(this.humanoidId, "PlatformStand", false);
        window.EngineAPI.setProperty(this.humanoidId, "HipHeight", 0);
        window.EngineAPI.setProperty(this.humanoidId, "MaxSlopeAngle", 89);
        window.EngineAPI.setProperty(this.humanoidId, "RigType", "R6");
        window.EngineAPI.setProperty(this.humanoidId, "BreakJointsOnDeath", true);
        window.EngineAPI.setProperty(this.humanoidId, "RequiresNeck", true);
        this.updateHealthBar();

        const createLimb = (name, sizeX, sizeY, sizeZ, r, g, b) => {
            let id = window.EngineAPI.instanceNew("Part", this.playerId);
            window.EngineAPI.setProperty(id, "Name", name);
            window.EngineAPI.setProperty(id, "Size", sizeX, sizeY, sizeZ);
            window.EngineAPI.setProperty(id, "Color", r, g, b);
            window.EngineAPI.setProperty(id, "Anchored", false);
            window.EngineAPI.setProperty(id, "CanCollide", name === "Torso" || name === "Head"); 
            return id;
        };

        this.hrpId = createLimb("HumanoidRootPart", 2, 2, 1, 0.5, 0.5, 0.5);
        window.EngineAPI.setProperty(this.hrpId, "Transparency", 1);
        window.EngineAPI.setProperty(this.hrpId, "CanCollide", false);

        this.headId = createLimb("Head", 1, 1, 1, 0.627, 0.627, 0.627);
        this.torsoId = createLimb("Torso", 2, 2, 1, 0.627, 0.627, 0.627);
        this.leftArmId = createLimb("Left Arm", 1, 2, 1, 0.627, 0.627, 0.627);
        this.rightArmId = createLimb("Right Arm", 1, 2, 1, 0.627, 0.627, 0.627);
        this.leftLegId = createLimb("Left Leg", 1, 2, 1, 0.627, 0.627, 0.627);
        this.rightLegId = createLimb("Right Leg", 1, 2, 1, 0.627, 0.627, 0.627);

        const createWeld = (name, p0, p1) => {
            let id = window.EngineAPI.instanceNew("Weld", this.playerId);
            window.EngineAPI.setProperty(id, "Name", name);
            window.EngineAPI.setProperty(id, "Part0", p0);
            window.EngineAPI.setProperty(id, "Part1", p1);
            return id;
        };

        const createNoCollision = (name, p0, p1) => {
            let id = window.EngineAPI.instanceNew("NoCollisionConstraint", this.playerId);
            window.EngineAPI.setProperty(id, "Name", name);
            window.EngineAPI.setProperty(id, "Part0", p0);
            window.EngineAPI.setProperty(id, "Part1", p1);
            window.EngineAPI.setProperty(id, "Enabled", true);
            return id;
        };

        this.rootJointId = createWeld("RootJoint", this.torsoId, this.hrpId);
        this.torsoHeadNoColId = createNoCollision("TorsoHeadNoCollision", this.torsoId, this.headId);
        this.neckId = createWeld("Neck", this.torsoId, this.headId);
        this.lsId = createWeld("Left Shoulder", this.torsoId, this.leftArmId);
        this.rsId = createWeld("Right Shoulder", this.torsoId, this.rightArmId);
        this.lhId = createWeld("Left Hip", this.torsoId, this.leftLegId);
        this.rhId = createWeld("Right Hip", this.torsoId, this.rightLegId);

        this.hrp = window.blocks.find(b => b.userData.id === this.hrpId);
        this.torso = window.blocks.find(b => b.userData.id === this.torsoId);
        this.head = window.blocks.find(b => b.userData.id === this.headId);
        this.leftArm = window.blocks.find(b => b.userData.id === this.leftArmId);
        this.rightArm = window.blocks.find(b => b.userData.id === this.rightArmId);
        this.leftLeg = window.blocks.find(b => b.userData.id === this.leftLegId);
        this.rightLeg = window.blocks.find(b => b.userData.id === this.rightLegId);

        [this.hrp, this.torso, this.head, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg].forEach(p => {
            if (p) p.userData.isPlayerPart = true;
        });

        this.rootJointWeld = window.non3DItems.find(i => i.uuid === this.rootJointId);
        this.neckWeld = window.non3DItems.find(i => i.uuid === this.neckId);
        this.lsWeld = window.non3DItems.find(i => i.uuid === this.lsId);
        this.rsWeld = window.non3DItems.find(i => i.uuid === this.rsId);
        this.lhWeld = window.non3DItems.find(i => i.uuid === this.lhId);
        this.rhWeld = window.non3DItems.find(i => i.uuid === this.rhId);

        window.non3DItems.push({ isSound: true, name: "Died", uuid: THREE.MathUtils.generateUUID(), parent: this.hrpId, Volume: 1, SoundId: "./content/sounds/oof.ogg" });
        window.non3DItems.push({ isSound: true, name: "Jumping", uuid: THREE.MathUtils.generateUUID(), parent: this.hrpId, Volume: 1, SoundId: "./content/sounds/action_jump.mp3" });
        window.non3DItems.push({ isSound: true, name: "Running", uuid: THREE.MathUtils.generateUUID(), parent: this.hrpId, Volume: 1, SoundId: "./content/sounds/action_footsteps_plastic.mp3" });
        window.non3DItems.push({ isSound: true, name: "Landed", uuid: THREE.MathUtils.generateUUID(), parent: this.hrpId, Volume: 1, SoundId: "./content/sounds/action_jump_land.mp3" });

        window.non3DItems.push({ isVector3Value: true, name: "OriginalSize", uuid: THREE.MathUtils.generateUUID(), parent: this.hrpId, Value: [2, 2, 1] });

        const rootAttId = THREE.MathUtils.generateUUID();
        window.non3DItems.push({ isAttachment: true, name: "RootAttachment", uuid: rootAttId, parent: this.hrpId, Position: [0,0,0], Rotation: [0,0,0] });
        window.non3DItems.push({ isVector3Value: true, name: "OriginalPosition", uuid: THREE.MathUtils.generateUUID(), parent: rootAttId, Value: [0,0,0] });

        const rootRigAttId = THREE.MathUtils.generateUUID();
        window.non3DItems.push({ isAttachment: true, name: "RootRigAttachment", uuid: rootRigAttId, parent: this.hrpId, Position: [0,0,0], Rotation: [0,0,0] });
        window.non3DItems.push({ isVector3Value: true, name: "OriginalPosition", uuid: THREE.MathUtils.generateUUID(), parent: rootRigAttId, Value: [0, -0.35, 0] });

        // --- FETCH AVATAR USER DATA ---
        let uData = {};
        try { uData = JSON.parse(localStorage.getItem('userData') || '{}'); } catch(e) {}
        
        const bcData = uData.bodyColors || {
            Head: "#A0A0A0", Torso: "#A0A0A0", LeftArm: "#A0A0A0", RightArm: "#A0A0A0", LeftLeg: "#A0A0A0", RightLeg: "#A0A0A0"
        };

        const bcObj = {
            isBodyColors: true, name: "Body Colors", uuid: THREE.MathUtils.generateUUID(), parent: this.playerId,
            HeadColor: bcData.Head, TorsoColor: bcData.Torso, LeftArmColor: bcData.LeftArm, RightArmColor: bcData.RightArm, LeftLegColor: bcData.LeftLeg, RightLegColor: bcData.RightLeg
        };
        window.non3DItems.push(bcObj);
        if (window.applyBodyColors) window.applyBodyColors(bcObj);

        // --- CHARACTER MESHES ---
        window.non3DItems.push({ isSpecialMesh: true, name: "Mesh", uuid: THREE.MathUtils.generateUUID(), parent: this.headId, MeshType: "FileMesh", MeshId: "./content/player/head.glb" });
        window.non3DItems.push({ isSpecialMesh: true, name: "Mesh", uuid: THREE.MathUtils.generateUUID(), parent: this.torsoId, MeshType: "FileMesh", MeshId: "./content/fonts/CompositTorsoBase.mesh" });
        window.non3DItems.push({ isSpecialMesh: true, name: "Mesh", uuid: THREE.MathUtils.generateUUID(), parent: this.leftArmId, MeshType: "FileMesh", MeshId: "./content/fonts/CompositLeftArmBase.mesh" });
        window.non3DItems.push({ isSpecialMesh: true, name: "Mesh", uuid: THREE.MathUtils.generateUUID(), parent: this.rightArmId, MeshType: "FileMesh", MeshId: "./content/fonts/CompositRightArmBase.mesh" });
        window.non3DItems.push({ isSpecialMesh: true, name: "Mesh", uuid: THREE.MathUtils.generateUUID(), parent: this.leftLegId, MeshType: "FileMesh", MeshId: "./content/fonts/CompositLeftLegBase.mesh" });
        window.non3DItems.push({ isSpecialMesh: true, name: "Mesh", uuid: THREE.MathUtils.generateUUID(), parent: this.rightLegId, MeshType: "FileMesh", MeshId: "./content/fonts/CompositRightLegBase.mesh" });

        // --- EQUIPPED AVATAR ITEMS ---
        window.non3DItems.push({
            isDecal: true, name: "face", uuid: THREE.MathUtils.generateUUID(), parent: this.headId, Face: "Front", Texture: uData.equippedFace || "./content/player/face.png"
        });

        // All 8 accessory kinds (Hat/Hair/Face Accessory/Neck/Shoulder/Front/Back/Waist -
        // see window.ACCESSORY_TYPES/window.ACCESSORY_ATTACH_CONFIG in studio.html), not
        // just Hair+one Hat slot - matches every equip slot the Avatar Editor (display.html)
        // and the Catalog (server.js's CATEGORY_APPEARANCE_SLOT) actually use.
        const ACCESSORY_EQUIP_SLOTS = {
            equippedHat: 'Hat', equippedHair: 'Hair', equippedFaceAccessory: 'Face',
            equippedNeck: 'Neck', equippedShoulder: 'Shoulder', equippedFront: 'Front',
            equippedBack: 'Back', equippedWaist: 'Waist'
        };
        Object.entries(ACCESSORY_EQUIP_SLOTS).forEach(([uField, accessoryType]) => {
            const itemUrl = uData[uField];
            if (!itemUrl) return;

            const accessoryUuid = THREE.MathUtils.generateUUID();
            // The catalog encodes which loader to use right in the URL's extension (see
            // itemPath in server.js's /catalog/upload) - .glb/.gltf load through
            // GLTFLoader, .obj through OBJLoader, and .json is the portable "parts" list
            // Studio's Item Creator converts .rbxm/.rbxmx into. Legacy/unrecognized URLs
            // (old saves) fall through to the original GLB behavior untouched.
            let modelFormat = null;
            if (/\.obj(\?|$)/i.test(itemUrl)) modelFormat = 'obj';
            else if (/\.json(\?|$)/i.test(itemUrl)) modelFormat = 'parts';
            else if (/\.gltf(\?|$)/i.test(itemUrl)) modelFormat = 'gltf';

            window.non3DItems.push({
                isAccessory: true, name: accessoryType, uuid: accessoryUuid, parent: this.playerId,
                AccessoryType: accessoryType, GLBData: itemUrl, ModelFormat: modelFormat
            });

            // Fetch this item's attached effects (particle emitters/lights - see the
            // Item Creator's "Attached Effects" editor) so they can be spawned as real
            // child instances once the accessory's mesh finishes loading. This is a
            // fire-and-forget enhancement - the accessory itself renders immediately
            // above regardless of whether/when this resolves.
            const idMatch = itemUrl.match(/\/catalog\/model\/(\d+)/);
            if (idMatch) {
                const serverUrl = window.RETROBLOX_SERVER_URL || "https://retroblox-servers.onrender.com";
                fetch(`${serverUrl}/catalog/${idMatch[1]}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(item => {
                        if (!item || !Array.isArray(item.children) || !item.children.length) return;
                        const accessoryObj = window.non3DItems.find(i => i.uuid === accessoryUuid);
                        if (accessoryObj) accessoryObj.EffectChildren = item.children;
                    })
                    .catch(() => { /* no attached effects - not fatal, accessory still renders */ });
            }
        });

        if (uData.equippedShirt) {
            window.non3DItems.push({ isShirt: true, name: "Shirt", uuid: THREE.MathUtils.generateUUID(), parent: this.playerId, Template: uData.equippedShirt });
        }
        if (uData.equippedPants) {
            window.non3DItems.push({ isPants: true, name: "Pants", uuid: THREE.MathUtils.generateUUID(), parent: this.playerId, Template: uData.equippedPants });
        }
        if (uData.equippedTShirt) {
            window.non3DItems.push({ isDecal: true, name: "roblox", uuid: THREE.MathUtils.generateUUID(), parent: this.torsoId, Face: "Front", Texture: uData.equippedTShirt });
        }

        const healthScript = `-- Gradually regenerates the Humanoid's Health over time.\n\nlocal REGEN_RATE = 1/100 -- Regenerate this fraction of MaxHealth per second.\nlocal REGEN_STEP = 1 -- Wait this long between each regeneration step.\n\nlocal Character = script.Parent\nlocal Humanoid = Character:WaitForChild('Humanoid')\n\nwhile true do\n\twhile Humanoid.Health < Humanoid.MaxHealth do\n\t\tlocal dt = wait(REGEN_STEP)\n\t\tlocal dh = dt*REGEN_RATE*Humanoid.MaxHealth\n\t\tHumanoid.Health = math.min(Humanoid.Health + dh, Humanoid.MaxHealth)\n\tend\n\tHumanoid.HealthChanged:Wait()\nend`;
        const healthScriptObj = { isScript: true, type: "Script", name: "Health", uuid: THREE.MathUtils.generateUUID(), parent: this.playerId, content: healthScript, disabled: false };
        window.non3DItems.push(healthScriptObj);

        if (window.executeLuaScript) {
            window.executeLuaScript(healthScriptObj);
        }

        const spawns = window.blocks.filter(b => b.isSpawnpoint);
        if (spawns.length > 0) {
            const spawn = spawns[Math.floor(Math.random() * spawns.length)];
            this.spawnPoint.copy(spawn.position);
            this.spawnPoint.y += spawn.scale.y + 3;
        } else {
            this.spawnPoint.set(0, 5, 0);
        }

this.torso.position.copy(this.spawnPoint);
        this.torso.rotation.set(0,0,0);
        this.velocityY = 0;
        this.isJumping = false;
        this.currentVelocity.set(0,0,0);
        this.velX = 0;
        this.velZ = 0;
        this.groundY = this.torso.position.y - 3.0;

        this.updateWelds(0, 0, 0, 0); 

        setTimeout(() => { this.isRespawning = false; }, 1000);
    }

    updateWelds(la, ra, ll, rl) {
        if (this.isDead) return;

        const setWeld = (weld, jointX, jointY, jointZ, centerX, centerY, centerZ, angleX) => {
            if (!weld) return;
            let quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(angleX, 0, 0));
            let joint = new THREE.Vector3(jointX, jointY, jointZ);
            let center = new THREE.Vector3(centerX, centerY, centerZ).applyQuaternion(quat);
            weld.offset = joint.add(center);
            weld.rotOffset = quat;
            
            if (this.torso) {
                let p0 = window.blocks.find(b => window.getId(b) === weld.Part0);
                let p1 = window.blocks.find(b => window.getId(b) === weld.Part1);
                if (p0 && p1 && p0 === this.torso) {
                    p1.position.copy(p0.position).add(weld.offset.clone().applyQuaternion(p0.quaternion));
                    p1.quaternion.copy(p0.quaternion).multiply(weld.rotOffset);
                }
            }
        };

        setWeld(this.rootJointWeld, 0, 0, 0, 0, 0, 0, 0);
        setWeld(this.neckWeld, 0, 1, 0, 0, 0.5, 0, 0);
        setWeld(this.lsWeld, 1.5, 0.5, 0, 0, -0.5, 0, la);
        setWeld(this.rsWeld, -1.5, 0.5, 0, 0, -0.5, 0, ra);
        setWeld(this.lhWeld, 0.5, -1, 0, 0, -1, 0, ll);
        setWeld(this.rhWeld, -0.5, -1, 0, 0, -1, 0, rl);

        // Equipped tools are attached via a "RightGrip" weld (Right Arm -> tool Handle)
        // that studio.html creates on equip, with its own fixed offset/rotOffset (unlike
        // the limb welds above, its transform isn't derived from an angle here - it's set
        // once at equip time). Nothing was ever re-applying it each frame, so a held tool
        // just stayed wherever it happened to be sitting in Studio instead of following the
        // hand. Apply it here, after the arm itself has been positioned above, so it reads
        // the arm's up-to-date transform for this frame.
        if (window.equippedTool && window.non3DItems) {
            const grip = window.non3DItems.find(i => i.isWeld && i.name === "RightGrip");
            if (grip && grip.offset && grip.rotOffset) {
                const p0 = window.blocks.find(b => window.getId(b) === grip.Part0);
                const p1 = window.blocks.find(b => window.getId(b) === grip.Part1);
                if (p0 && p1) {
                    p1.position.copy(p0.position).add(grip.offset.clone().applyQuaternion(p0.quaternion));
                    p1.quaternion.copy(p0.quaternion).multiply(grip.rotOffset);
                } else if (!window._toolGripWarned) {
                    console.warn('[Tool] RightGrip weld exists but its Handle or Right Arm is not a live 3D block (p0 found:', !!p0, ', p1/Handle found:', !!p1, ') - the Handle may not be an actual Part.');
                    window._toolGripWarned = true;
                }
            } else if (!window._toolNoGripWarned) {
                console.warn('[Tool] A tool is equipped but no "RightGrip" weld exists - it likely has no Part named "Handle" inside it.');
                window._toolNoGripWarned = true;
            }
        }
    }

    // Subtle Idle / Idle1 / Idle2-style variation: swaps pose every ~9s, plus a soft breathing sway.
    getIdlePose() {
        const t = performance.now() / 1000;
        const cycleIndex = Math.floor((t + this.idleSeed) / 9) % 3;
        const breathe = Math.sin(t * 1.2) * 0.03;

        if (cycleIndex === 1) return { la: 0.08 + breathe, ra: -0.03, ll: 0, rl: 0 };
        if (cycleIndex === 2) return { la: -0.03, ra: 0.1 + breathe, ll: 0, rl: 0 };
        return { la: breathe, ra: -breathe, ll: 0, rl: 0 };
    }

    // Plays a built-in emote. Wire this up to your chat command parser, e.g.
    // if (message === "/e wave") player.playEmote("wave");
    playEmote(name) {
        const valid = ["wave", "point", "dance", "dance2", "dance3", "laugh", "cheer"];
        if (!valid.includes(name) || this.isDead || this.isSitting) return;
        this.emoteName = name;
        this.emoteStartTime = performance.now();
    }

    getEmotePose() {
        const elapsed = (performance.now() - this.emoteStartTime) / 1000;
        const wag = Math.sin(elapsed * 8);

        switch (this.emoteName) {
            case "wave":
                if (elapsed > 2) { this.emoteName = null; return null; }
                return { la: 0, ra: -Math.PI * 0.8 + wag * 0.3, ll: 0, rl: 0 };
            case "point":
                if (elapsed > 1.5) { this.emoteName = null; return null; }
                return { la: 0, ra: -Math.PI / 2, ll: 0, rl: 0 };
            case "laugh":
                if (elapsed > 2) { this.emoteName = null; return null; }
                return { la: 0.4 + wag * 0.1, ra: -0.4 - wag * 0.1, ll: 0, rl: 0 };
            case "cheer":
                if (elapsed > 2) { this.emoteName = null; return null; }
                return { la: Math.PI * 0.9, ra: -Math.PI * 0.9, ll: 0, rl: 0 };
            case "dance":
                if (elapsed > 3) { this.emoteName = null; return null; }
                return {
                    la: Math.sin(elapsed * 6) * 0.9,
                    ra: -Math.sin(elapsed * 6 + 1) * 0.9,
                    ll: Math.sin(elapsed * 6 + 2) * 0.3,
                    rl: -Math.sin(elapsed * 6 + 2) * 0.3
                };
            case "dance2":
                if (elapsed > 3) { this.emoteName = null; return null; }
                return {
                    la: Math.cos(elapsed * 5) * 0.7 + 0.3,
                    ra: -Math.cos(elapsed * 5) * 0.7 - 0.3,
                    ll: 0, rl: 0
                };
            case "dance3":
                if (elapsed > 3) { this.emoteName = null; return null; }
                return {
                    la: Math.PI * 0.5 + Math.sin(elapsed * 10) * 0.4,
                    ra: -Math.PI * 0.5 - Math.sin(elapsed * 10) * 0.4,
                    ll: Math.sin(elapsed * 10) * 0.4,
                    rl: -Math.sin(elapsed * 10) * 0.4
                };
            default:
                this.emoteName = null;
                return null;
        }
    }

    update(camYaw, camPitch, camDist) {
        if (!this.torso || !this.head) return camDist;

        // 2016 camera: pitch clamped to roughly +/-80 degrees
        const pitchLimit = 80 * Math.PI / 180;
        camPitch = Math.max(-pitchLimit, Math.min(pitchLimit, camPitch));

        // Apply any accumulated mouse-wheel zoom (exponential, not linear)
        if (this._pendingZoomFactor && this._pendingZoomFactor !== 1) {
            camDist = camDist * this._pendingZoomFactor;
            camDist = Math.max(this.minZoom, Math.min(this.maxZoom, camDist));
            this._pendingZoomFactor = 1;
        }

        let posBefore = this.torso.position.clone();
        
        const forward = new THREE.Vector3(); 
        this.camera.getWorldDirection(forward);
        forward.y = 0; forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        if (!this.isDead) {
            const torsoGone = !window.blocks.includes(this.torso);
            const headGone = !window.blocks.includes(this.head);
            const requiresNeck = window.EngineAPI.getProperty(this.humanoidId, "RequiresNeck") !== false;
            const neckBroken = requiresNeck && (!this.neckWeld || !this.neckWeld.Part0 || !this.neckWeld.Part1 ||
                !window.blocks.find(b => window.getId(b) === this.neckWeld.Part0) || !window.blocks.find(b => window.getId(b) === this.neckWeld.Part1));

            if (torsoGone || headGone || neckBroken) {
                this.die();
                return camDist;
            }

            const hWalkSpeed = window.EngineAPI.getProperty(this.humanoidId, "WalkSpeed");
            const hJumpPower = window.EngineAPI.getProperty(this.humanoidId, "JumpPower");
            this.walkSpeed = (typeof hWalkSpeed === "number" ? hWalkSpeed : 16) / 60;
            
            let targetJumpPower = (typeof hJumpPower === "number" ? hJumpPower : 50);
            if (targetJumpPower === 50) targetJumpPower = 53.15; 
            this.jumpPower = targetJumpPower / 60;
            
            this.hipHeight = window.EngineAPI.getProperty(this.humanoidId, "HipHeight") || 0;
            this.isPlatformStand = window.EngineAPI.getProperty(this.humanoidId, "PlatformStand");

            const humanoidSit = window.EngineAPI.getProperty(this.humanoidId, "Sit");
            if (typeof humanoidSit === "boolean" && humanoidSit !== this.isSitting) this.isSitting = humanoidSit;

            if (this.keys["q"]) {
                if (!this.qKeyWasPressed) {
                    this.isSitting = !this.isSitting; 
                    this.qKeyWasPressed = true;
                }
            } else {
                this.qKeyWasPressed = false;
            }
            window.EngineAPI.setProperty(this.humanoidId, "Sit", this.isSitting);

            // Shift Lock: toggles on key press (not held), like 2016 Roblox.
            // Gated by the "Shift Lock Switch" setting (window.shiftLockEnabled, On by default) --
            // when Off, pressing Shift does nothing at all.
            const shiftLockSettingOn = window.shiftLockEnabled !== false;
            const shiftKeyDown = this.keys["shift"] || this.keys["shiftleft"] || this.keys["shiftright"];
            if (shiftKeyDown) {
                if (!this.shiftKeyWasPressed) {
                    this.shiftKeyWasPressed = true;
                    if (shiftLockSettingOn) {
                        this.shiftLock = !this.shiftLock;
                        if (this.shiftLock && !document.pointerLockElement) document.body.requestPointerLock();
                    }
                }
            } else {
                this.shiftKeyWasPressed = false;
            }

            const isPhysicallyDisabled = this.isSitting || this.isPlatformStand || this.isPhysicsLocked || this.isGettingUp;

            const moveVec = new THREE.Vector3();
            let moveSpeedScale = 1;
            const hasAnalogInput = this.analogMove && (Math.abs(this.analogMove.x) > 0.001 || Math.abs(this.analogMove.y) > 0.001);
            if (!isPhysicallyDisabled) {
                if (hasAnalogInput) {
                    // Full 360-degree analog stick movement: direction is whatever angle the
                    // stick is pushed at, speed scales with how far it's pushed (not just on/off).
                    moveVec.addScaledVector(forward, -this.analogMove.y);
                    moveVec.addScaledVector(right, this.analogMove.x);
                    moveSpeedScale = Math.min(1, moveVec.length());
                } else {
                    if (this.keys['w']) moveVec.add(forward);
                    if (this.keys['s']) moveVec.sub(forward);
                    if (this.keys['a']) moveVec.sub(right);
                    if (this.keys['d']) moveVec.add(right);
                }
            }

const isMoving = moveVec.lengthSq() > 0;
            const lockedToCamera = camDist < 1 || this.shiftLock;

            // --- MOMENTUM & SLIDING PHYSICS ---
            let props = window.getMaterialProperties ? window.getMaterialProperties(this.floorMaterial) : { friction: 0.3 };
            let friction = this.onGround ? props.friction : 0.01; // Air control is very slippery
            
            // Curve the acceleration so grippy materials are instant, but slippery ones slide a lot
            let accel = this.onGround ? Math.min(1.0, (friction * friction * 2.0) + 0.02) : 0.05;

            if (isMoving && !isPhysicallyDisabled) {
                moveVec.normalize();
                let targetVelX = moveVec.x * (this.walkSpeed * moveSpeedScale);
                let targetVelZ = moveVec.z * (this.walkSpeed * moveSpeedScale);
                
                this.velX += (targetVelX - this.velX) * accel;
                this.velZ += (targetVelZ - this.velZ) * accel;
            } else {
                this.velX += (0 - this.velX) * accel;
                this.velZ += (0 - this.velZ) * accel;
            }

            // Apply velocity
            this.torso.position.x += this.velX;
            this.torso.position.z += this.velZ;

            // Facing direction. In First Person / Shift Lock the body is locked to the camera's
            // look direction EVERY frame (not just while moving), so turning the camera turns the
            // body even while standing still. Otherwise it eases toward the movement direction.
            if (!isPhysicallyDisabled) {
                if (lockedToCamera) {
                    this.torso.rotation.y = camYaw;
                } else if (isMoving) {
                    let targetY = Math.atan2(moveVec.x, moveVec.z) + Math.PI;
                    let diff = targetY - this.torso.rotation.y;
                    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); 
                    this.torso.rotation.y += diff * 0.4; 
                }
            }

            // The torso is 2x1 studs (X x Z), but collision below used a single circular
            // radius (1.2) around its center. That circle had to be big enough to cover the
            // torso's diagonal corners, which made it ~0.7 studs bigger than the torso's real
            // half-depth (0.5) on the front/back (Z) side -- that gap was the "invisible wall"
            // you'd hit before actually reaching a wall when walking forward. Using separate
            // half-extents that hug the torso's actual size instead removes that gap.
            const playerHalfX = 1.0;
            const playerHalfZ = 0.55;
            const hoverDist = isPhysicallyDisabled ? 1.0 : 3.0 + this.hipHeight;
            const currentFootY = this.torso.position.y - hoverDist;
            const maxStepHeight = 1.5; 
            const bodyBottom = currentFootY + maxStepHeight; 
            const playerTop = this.torso.position.y + 1.5;

window.blocks.forEach(block => {
                if (block.userData.canCollide === false) return;
                if (block.userData.isTerrainMesh) return; // Skip terrain for AABB horizontal check
                if ([this.hrpId, this.torsoId, this.headId, this.leftArmId, this.rightArmId, this.leftLegId, this.rightLegId].includes(block.userData.id)) return;

                let dx = this.torso.position.x - block.position.x;
                let dy = this.torso.position.y - block.position.y;
                let dz = this.torso.position.z - block.position.z;
                let maxExtent = Math.max(block.scale.x, block.scale.y, block.scale.z) * 1.732;
                if (dx*dx + dy*dy + dz*dz > (maxExtent + 5) * (maxExtent + 5)) return;

                let localPos = new THREE.Vector3(this.torso.position.x, this.torso.position.y, this.torso.position.z);
                block.worldToLocal(localPos);

                let closestLocal = new THREE.Vector3(
                    Math.max(-1, Math.min(localPos.x, 1)),
                    Math.max(-1, Math.min(localPos.y, 1)),
                    Math.max(-1, Math.min(localPos.z, 1))
                );

                let isInside = (Math.abs(localPos.x) < 1 && Math.abs(localPos.y) < 1 && Math.abs(localPos.z) < 1);
                if (isInside) {
                    let distToX = 1 - Math.abs(localPos.x);
                    let distToY = 1 - Math.abs(localPos.y);
                    let distToZ = 1 - Math.abs(localPos.z);
                    
                    if (distToX < distToY && distToX < distToZ) {
                        closestLocal.x = Math.sign(localPos.x) * 1;
                    } else if (distToY < distToX && distToY < distToZ) {
                        closestLocal.y = Math.sign(localPos.y) * 1;
                    } else {
                        closestLocal.z = Math.sign(localPos.z) * 1;
                    }
                }

                let closestWorld = closestLocal.clone();
                block.localToWorld(closestWorld);

                if (closestWorld.y > bodyBottom + 0.1 && closestWorld.y < playerTop) {
                    let diffX = this.torso.position.x - closestWorld.x;
                    let diffZ = this.torso.position.z - closestWorld.z;
                    let distSq = diffX * diffX + diffZ * diffZ;

                    if (Math.abs(diffX) < playerHalfX && Math.abs(diffZ) < playerHalfZ && distSq > 0.0001) {
                        // Resolve along whichever axis is penetrated less, like a normal
                        // box-vs-box push-out, instead of pushing straight away from the
                        // point (which is what made the boundary behave like a circle).
                        let overlapX = playerHalfX - Math.abs(diffX);
                        let overlapZ = playerHalfZ - Math.abs(diffZ);
                        let pushX = 0, pushZ = 0;
                        if (overlapX < overlapZ) {
                            pushX = Math.sign(diffX) * overlapX;
                        } else {
                            pushZ = Math.sign(diffZ) * overlapZ;
                        }

if (block.userData.anchored === false) {
                            if (!block.userData.vel) block.userData.vel = new THREE.Vector3();
                            if (!block.userData.rotVel) block.userData.rotVel = new THREE.Vector3();
                            
                            let pushDir = new THREE.Vector3(-pushX, 0, -pushZ).normalize();
                            block.userData.vel.x += pushDir.x * 0.1;
                            block.userData.vel.z += pushDir.z * 0.1;
                            block.userData.rotVel.x -= pushDir.z * 0.05;
                            block.userData.rotVel.z += pushDir.x * 0.05;
                            
                            this.torso.position.x += pushX * 0.2;
                            this.torso.position.z += pushZ * 0.2;
                        } else {
                            this.torso.position.x += pushX;
                            this.torso.position.z += pushZ;
                            // Dampen velocity when hitting a wall so you don't slide along it infinitely
                            this.velX *= 0.8;
                            this.velZ *= 0.8;
                        }
                    }
                }
            });

            this.isClimbing = false; 

            const humanoidJumpRequested = window.EngineAPI.getProperty(this.humanoidId, "Jump") === true;
            if (humanoidJumpRequested) window.EngineAPI.setProperty(this.humanoidId, "Jump", false);

            if ((this.keys[' '] || this.gamepadJump || humanoidJumpRequested) && !isPhysicallyDisabled) {
                if (this.isSitting) {
                    this.isSitting = false;
                    this.velocityY = this.jumpPower;
                    this.isJumping = true;
                } else if (!this.isJumping) {
                    this.velocityY = this.jumpPower;
                    this.isJumping = true;
                }
            }

            // --- BodyForce integration (Gravity Coils, jetpacks, force fields, etc.) ---
            // Any BodyForce instance parented somewhere in the character's connected assembly
            // (e.g. one dropped onto the Torso by an equipped tool's script) contributes an
            // acceleration of Force/TotalMass, exactly like Roblox's real physics solver. This
            // is deliberately generic - it's not gravity-coil-specific - so any future script
            // that creates a BodyForce works the same way without touching this file again.
            let bodyForceAccelY = 0;
            if (window.getConnectedPartIds && window.getAssemblyMass && window.non3DItems && this.torsoId) {
                const assemblyIds = window.getConnectedPartIds(this.torsoId, true);
                let totalForceY = 0;
                let hasForce = false;
                window.non3DItems.forEach(item => {
                    if (item.isBodyForce && item.Force && assemblyIds.has(item.parent)) {
                        totalForceY += item.Force[1] || 0;
                        hasForce = true;
                    }
                });
                if (hasForce) {
                    const assemblyMass = window.getAssemblyMass(this.torsoId) || 1;
                    bodyForceAccelY = (totalForceY / assemblyMass) / 3600; // studs/s^2 -> per-frame, matches this.gravity's own scaling
                }
            }

            this.torso.position.y += this.velocityY;
            this.velocityY -= this.gravity; 
            this.velocityY += bodyForceAccelY;

            let highestGroundY = -Infinity;
            let hitGroundBlock = null;
            let ceilingY = Infinity;

            // playerTop (declared above, before this frame's "this.torso.position.y += this.velocityY")
            // is now stale -- recompute it against the post-move position for the ceiling checks below.
            const playerTopNow = this.torso.position.y + 1.5;

let startY = this.torso.position.y + 2.0; 
            let endY = this.torso.position.y - hoverDist - 2.0; 
            
            let checkPoints = [
                {x: 0, z: 0},
                {x: playerHalfX * 0.7, z: 0},
                {x: -playerHalfX * 0.7, z: 0},
                {x: 0, z: playerHalfZ * 0.7},
                {x: 0, z: -playerHalfZ * 0.7}
            ];

            let collidableBlocks = window.blocks.filter(b => b.userData.canCollide !== false && ![this.hrpId, this.torsoId, this.headId, this.leftArmId, this.rightArmId, this.leftLegId, this.rightLegId].includes(b.userData.id));
            
            let downRay = new THREE.Raycaster();
            let upRay = new THREE.Raycaster();
            let downDir = new THREE.Vector3(0, -1, 0);
            let upDir = new THREE.Vector3(0, 1, 0);

            for (let pt of checkPoints) {
                let origin = new THREE.Vector3(this.torso.position.x + pt.x, startY, this.torso.position.z + pt.z);
                
                downRay.set(origin, downDir);
                downRay.far = startY - endY;
                let hits = downRay.intersectObjects(collidableBlocks, false);
                if (hits.length > 0) {
                    if (hits[0].point.y > highestGroundY) {
                        highestGroundY = hits[0].point.y;
                        hitGroundBlock = hits[0].object;
                    }
                }

                // Search upward over the same vertical span as the ground ray above (just flipped),
                // starting from the same point comfortably above the head. The old "playerTop - startY"
                // here was always negative (startY sits above playerTop), so this ray's far distance was
                // negative too -- Raycaster then discards every hit as being past the ray's range, meaning
                // this never once detected a block overhead and the player could jump straight through one.
                upRay.set(origin, upDir);
                upRay.far = startY - endY;
                let upHits = upRay.intersectObjects(collidableBlocks, false);
                if (upHits.length > 0) {
                    if (upHits[0].point.y < ceilingY) {
                        ceilingY = upHits[0].point.y;
                    }
                }
            }
            let hitGround = false;

            if (ceilingY !== Infinity && highestGroundY !== -Infinity) {
                this.isPhysicsLocked = (ceilingY - highestGroundY) < 4.5;
            } else {
                this.isPhysicsLocked = false;
            }

            if (highestGroundY !== -Infinity) {
                let currentFootY = this.torso.position.y - hoverDist;
                let newFootY = currentFootY + this.velocityY;
                let wasAbove = currentFootY >= highestGroundY - 0.1;
                let isBelow = newFootY <= highestGroundY + 0.1;

                if (this.velocityY <= 0 && isBelow && (newFootY >= highestGroundY - maxStepHeight - 0.1 || wasAbove)) {
                    this.torso.position.y = highestGroundY + hoverDist;
                    this.velocityY = 0;
                    this.isJumping = false;
                    hitGround = true;
                    this.groundY = highestGroundY;

                    if (hitGroundBlock && hitGroundBlock.userData.anchored === false) {
                        if (!hitGroundBlock.userData.vel) hitGroundBlock.userData.vel = new THREE.Vector3();
                        hitGroundBlock.userData.vel.y -= 0.05; 
                    }
                }
            }

            if (this.velocityY > 0 && playerTopNow >= ceilingY - 0.1) {
                this.torso.position.y = ceilingY - 1.5 - 0.1;
                this.velocityY = 0;
            }

            // NOTE: there used to be a hardcoded "invisible floor" here that caught the player at
            // y:0 anywhere within roughly the middle of the map, regardless of whether any actual
            // part existed there. That's what made the Baseplate seem to keep its collision after
            // being deleted -- its top surface sits at y:0, so this stood in for it even once the
            // real part (and its entry in window.blocks) was gone. Collision now comes only from
            // the raycasts above against whatever is actually in window.blocks, and falling with no
            // ground under you is caught by the death-plane check below instead.

this.onGround = hitGround;
            if (hitGround && hitGroundBlock) {
                this.floorMaterial = hitGroundBlock.userData.material || 'Plastic';
            }

            if (!hitGround && this.velocityY < 0 && !this.isSitting) {
                this.isJumping = true;
            }

            if (this.torso.position.y < -50) {
                this.die();
            }

if (window.luaDispatcher && this.hrp) {
                if (!window._touchingSets) window._touchingSets = {};
                const bodyParts = [
                    { id: this.hrpId, mesh: this.hrp },
                    { id: this.torsoId, mesh: this.torso },
                    { id: this.headId, mesh: this.head },
                    { id: this.leftArmId, mesh: this.leftArm },
                    { id: this.rightArmId, mesh: this.rightArm },
                    { id: this.leftLegId, mesh: this.leftLeg },
                    { id: this.rightLegId, mesh: this.rightLeg }
                ];

                bodyParts.forEach(part => {
                    if (!part.mesh) return;
                    part.mesh.updateMatrixWorld();
                    const limbId = part.id;
                    const touchingSet = window._touchingSets[limbId] || (window._touchingSets[limbId] = new Set());
                    const stillTouching = new Set();
                    const touchBox = new THREE.Box3().setFromObject(part.mesh);

                    window.blocks.forEach(block => {
                        if (!block.visible) return;
                        // Don't collide with own body parts
                        if (bodyParts.some(p => p.id === block.userData.id)) return;
                        
                        if (part.mesh.position.distanceToSquared(block.position) > 150) return;

                        block.updateMatrixWorld();
                        const blockBox = new THREE.Box3().setFromObject(block);

                        if (touchBox.intersectsBox(blockBox)) {
                            const oId = block.userData.id;
                            stillTouching.add(oId);
                            if (!touchingSet.has(oId)) {
                                console.log("[TouchDebug] FIRING Touched:", part.mesh.name, "<->", block.name, "(id:", oId + ")", "dispatcher type:", typeof window.luaDispatcher);
                                try {
                                    window.luaDispatcher(oId, "Touched", limbId);
                                    window.luaDispatcher(limbId, "Touched", oId);
                                    console.log("[TouchDebug] luaDispatcher call(s) returned normally");
                                } catch (dispatchErr) {
                                    console.error("[TouchDebug] luaDispatcher THREW:", dispatchErr);
                                }
                            }
                        }
                    });

                    touchingSet.forEach(oId => {
                        if (!stillTouching.has(oId)) {
                            window.luaDispatcher(oId, "TouchEnded", limbId);
                            window.luaDispatcher(limbId, "TouchEnded", oId);
                        }
                    });
                    window._touchingSets[limbId] = stillTouching;
                });
            }
            let horizSpeed = Math.sqrt(this.currentVelocity.x**2 + this.currentVelocity.z**2);
            let vertSpeed = this.velocityY;
            
            let newState = "Running";
            
            if (this.isDead) {
                newState = "Dead";
            } else if (this.isPlatformStand) {
                newState = "PlatformStanding";
            } else if (this.isSitting) {
                newState = "Seated";
            } else if (this.isGettingUp) {
                newState = "GettingUp";
            } else if (this.isSwimming) {
                newState = "Swimming";
            } else if (this.isClimbing) {
                newState = "Climbing";
            } else if (vertSpeed > 0.1 && !this.onGround) {
                newState = "Jumping";
            } else if (vertSpeed < -0.1 && !this.onGround) {
                newState = "Freefall";
            }

            let hum = window.non3DItems.find(i => i.uuid === this.humanoidId);
            if (hum) {
                let oldState = hum._currentState || "Idle";
                
                if (oldState === "PlatformStanding" && newState !== "PlatformStanding" && newState !== "Dead" && !this.isGettingUp) {
                    this.isGettingUp = true;
                    newState = "GettingUp";
                    setTimeout(() => { this.isGettingUp = false; }, 1200); 
                }

                // "Landed" fires briefly the instant Jumping/Freefall touches the ground
                if ((oldState === "Jumping" || oldState === "Freefall") && newState === "Running" && this.onGround) {
                    newState = "Landed";
                    this.isLanded = true;
                    setTimeout(() => { this.isLanded = false; }, 150);

                    let landSound = window.non3DItems.find(i => i.parent === this.hrpId && i.name === "Landed");
                    if (landSound && landSound.SoundId) { let a = new Audio(landSound.SoundId); a.volume = landSound.Volume || 1; a.play().catch(()=>{}); }
                }

                if (oldState !== newState) {
                    hum._currentState = newState;
                    if (window.luaDispatcher) {
                        window.luaDispatcher(this.humanoidId, "StateChanged", oldState, newState);
                    }
                    
                    if (newState === "Jumping") {
                        let s = window.non3DItems.find(i => i.parent === this.hrpId && i.name === "Jumping");
                        if (s && s.SoundId) { let a = new Audio(s.SoundId); a.volume = s.Volume || 1; a.play().catch(()=>{}); }
                    }
                }
                
                let runningSoundObj = window.non3DItems.find(i => i.parent === this.hrpId && i.name === "Running");
                if (newState === "Running" && horizSpeed > 0.05 && runningSoundObj && runningSoundObj.SoundId) {
                    if (!this.runningAudio || this.runningAudio.src !== new URL(runningSoundObj.SoundId, document.baseURI).href) {
                        if (this.runningAudio) this.runningAudio.pause();
                        this.runningAudio = new Audio(runningSoundObj.SoundId);
                        this.runningAudio.loop = true;
                        this.runningAudio.volume = runningSoundObj.Volume || 1;
                    }
                    if (this.runningAudio.paused) this.runningAudio.play().catch(()=>{});
                } else {
                    if (this.runningAudio) {
                        this.runningAudio.pause();
                        this.runningAudio = null;
                    }
                }
            }

            let targetLA = 0, targetRA = 0, targetLL = 0, targetRL = 0;

            if (newState === "PlatformStanding") {
                targetLA = Math.PI; targetRA = Math.PI;
                targetLL = 0; targetRL = 0;
            } else if (newState === "Seated") {
                targetLA = 0; targetRA = 0;
                targetLL = -Math.PI / 2; targetRL = -Math.PI / 2;
            } else if (newState === "GettingUp") {
                targetLA = -Math.PI / 4; targetRA = -Math.PI / 4;
                targetLL = -Math.PI / 4; targetRL = -Math.PI / 4;
            } else if (newState === "Jumping" || newState === "Freefall") {
                targetLA = Math.PI; targetRA = Math.PI; targetLL = 0; targetRL = 0;
            } else if (newState === "Landed") {
                targetLA = 0.3; targetRA = 0.3; targetLL = 0; targetRL = 0;
            } else if (newState === "Climbing") {
                this.walkCycle += 0.3;
                targetLA = Math.PI / 2 + Math.sin(this.walkCycle) * 0.6;
                targetRA = Math.PI / 2 - Math.sin(this.walkCycle) * 0.6;
                targetLL = -Math.sin(this.walkCycle) * 0.5;
                targetRL = Math.sin(this.walkCycle) * 0.5;
            } else if (newState === "Swimming") {
                this.walkCycle += 0.25;
                targetLA = Math.sin(this.walkCycle) * 1.2;
                targetRA = -Math.sin(this.walkCycle) * 1.2;
                targetLL = -Math.sin(this.walkCycle) * 0.6;
                targetRL = Math.sin(this.walkCycle) * 0.6;
} else if (newState === "Running") {
                let speedInStuds = horizSpeed * 60;
                if (speedInStuds >= 2.0) {
                    // Walk/Run animation speed scales with actual current speed relative to
                    // the classic 16 studs/sec baseline. If going slow (e.g. 2 studs/sec), 
                    // it plays very slowly.
                    const targetAnimSpeed = speedInStuds / 16;
                    if (typeof this._animSpeed !== "number") this._animSpeed = targetAnimSpeed;
                    this._animSpeed += (targetAnimSpeed - this._animSpeed) * 0.25;
                    this.walkCycle += 0.35 * this._animSpeed;
                    targetLA = Math.sin(this.walkCycle) * 0.8;
                    targetRA = -Math.sin(this.walkCycle) * 0.8;
                    targetLL = -Math.sin(this.walkCycle) * 0.8;
                    targetRL = Math.sin(this.walkCycle) * 0.8;
                } else {
                    // Speeds between 0 and 1.99 stay in the idle animation
                    this.walkCycle = 0;
                    this._animSpeed = 0;
                    const idlePose = this.getIdlePose();
                    targetLA = idlePose.la; targetRA = idlePose.ra;
                    targetLL = idlePose.ll; targetRL = idlePose.rl;
                }
            }
            // Emotes (/e wave, point, dance, dance2, dance3, laugh, cheer) only play while
            // idle on the ground; moving, jumping, sitting, etc. cancel them immediately.
            if (this.emoteName && newState === "Running" && horizSpeed <= 0.05) {
                const emotePose = this.getEmotePose();
                if (emotePose) {
                    targetLA = emotePose.la; targetRA = emotePose.ra;
                    targetLL = emotePose.ll; targetRL = emotePose.rl;
                }
            } else if (this.emoteName) {
                this.emoteName = null;
            }

            if (window.equippedTool && !this.emoteName) {
                // This was -Math.PI / 2, which (given this codebase's -Z-is-forward
                // convention, e.g. the tool-drop code) actually swings the arm backward
                // instead of raising it out in front of the character - that's the
                // "hand is backwards" pose. Flipping the sign raises it forward.
                targetRA = Math.PI / 2;
            }

            this.updateWelds(targetLA, targetRA, targetLL, targetRL);
            this.currentVelocity.subVectors(this.torso.position, posBefore);
        }

        let camTargetPos = new THREE.Vector3();
        if (this.isDead) {
            camDist = Math.max(5, camDist);
            if (this.torso) this.torso.getWorldPosition(camTargetPos);
            if (document.pointerLockElement) document.exitPointerLock();
        } else {
            camTargetPos = this.head.position.clone();
        }

        const dirX = -Math.sin(camYaw) * Math.cos(camPitch);
        const dirY = Math.sin(camPitch);
        const dirZ = -Math.cos(camYaw) * Math.cos(camPitch);

        // Shift Lock offsets the focus point ~1.75 studs to the right (third person only)
        if (this.shiftLock && camDist >= 1 && !this.isDead) {
            const camRight = new THREE.Vector3(-dirZ, 0, dirX).normalize();
            camTargetPos.addScaledVector(camRight, 1.75);
        }

        // Camera collision: raycast from the focus point toward the desired camera spot
        // and pull the distance in if a wall is in the way, instead of clipping through it.
        let effectiveDist = camDist;
        if (camDist >= 1 && !this.isDead && window.blocks) {
            const desiredCamPos = new THREE.Vector3(
                camTargetPos.x - dirX * camDist,
                camTargetPos.y - dirY * camDist,
                camTargetPos.z - dirZ * camDist
            );
            const toCam = desiredCamPos.clone().sub(camTargetPos);
            const rayLen = toCam.length();
            if (rayLen > 0.01) {
                this._camRaycaster.set(camTargetPos, toCam.normalize());
                this._camRaycaster.far = rayLen;
                const hits = this._camRaycaster.intersectObjects(window.blocks, false);
                const wallHit = hits.find(h => h.object.userData && !h.object.userData.isPlayerPart && h.object.userData.canCollide !== false);
                if (wallHit) effectiveDist = Math.max(0.5, wallHit.distance - 0.3);
            }
        }

        const bodyParts = [this.head, this.torso, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg];

        this.isFirstPerson = camDist < 1 && !this.isDead;

        // Zoom-based transparency fade (like Roblox's TransparencyController/Invisicam):
        // as the third-person camera zooms in close, the body (and accessories, read by
        // studio.html via this.zoomFadeAlpha) fade out smoothly before hitting the hard
        // first-person cutoff below, instead of popping straight from visible to invisible.
        const fadeStart = 4; // studs - fully opaque at/after this distance
        const fadeEnd = 1;   // studs - fully faded out by this distance (first person cutoff)
        this.zoomFadeAlpha = (!this.isDead && camDist < fadeStart)
            ? THREE.MathUtils.clamp((camDist - fadeEnd) / (fadeStart - fadeEnd), 0, 1)
            : 1;

        if (this.isFirstPerson) {
            // First Person: hide the whole body for the local client only. Other clients keep
            // their own independent scene, so this never affects how anyone else sees you.
            bodyParts.forEach(part => { if (part) part.visible = false; });
            this.camera.position.copy(camTargetPos);
            this.camera.lookAt(camTargetPos.x + dirX, camTargetPos.y + dirY, camTargetPos.z + dirZ);
            this.crosshair.style.display = document.pointerLockElement ? 'block' : 'none';
        } else {
            if (!this.isDead) {
                bodyParts.forEach(part => {
                    if (!part) return;
                    part.visible = true;
                    const baseTransparency = (part.userData && typeof part.userData.transparency === 'number') ? part.userData.transparency : 0;
                    const targetOpacity = (1 - baseTransparency) * this.zoomFadeAlpha;
                    const mats = Array.isArray(part.material) ? part.material : [part.material];
                    mats.forEach(m => {
                        if (!m) return;
                        if (targetOpacity < 1) { m.transparent = true; m.opacity = targetOpacity; }
                        else { m.transparent = false; m.opacity = 1; }
                    });
                });
            }
            this.crosshair.style.display = 'none';
            this.camera.position.set(camTargetPos.x - dirX * effectiveDist, camTargetPos.y - dirY * effectiveDist, camTargetPos.z - dirZ * effectiveDist);
            this.camera.lookAt(camTargetPos);
        }
        
        return camDist;
    }

    destroy() {
        if (this.playerId) window.EngineAPI.destroyInstance(this.playerId);
        if (this.healthInterval) clearInterval(this.healthInterval);
        if (this._wheelHandler) window.removeEventListener('wheel', this._wheelHandler);
        if (this.runningAudio) {
            this.runningAudio.pause();
            this.runningAudio.currentTime = 0;
        }
        this.scene = null;
    }
}
window.Player = Player;