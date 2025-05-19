import './App.css';
import { useEffect, useRef, useMemo, useState } from 'react';
import { Watch } from 'touch-sdk';
import { trait, createWorld, Entity } from 'koota'; 
import { useTrait, WorldProvider, useWorld } from 'koota/react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Edges, OrthographicCamera, Line as DreiLine } from '@react-three/drei'
import * as THREE from 'three';

interface Vector3 { x: number; y: number; z: number; }
interface Vector4 extends Vector3 { w: number; }
interface Vector2 { x: number; y: number; }
interface TouchScreenResolution { width: number; height: number; }
interface GestureProbDetail { [key: string]: number; }

const THROW_SPEED_SCALE = 500;
const ARM_DIRECTION_HISTORY_MAX_AGE_MS = 100; // Max age of samples in history
const THROW_GESTURE_WINDOW_MS = 30;      // Window to calculate throw direction from
const MIN_THROW_SPEED_THRESHOLD = 5.0;    // Speed (pixels/sec) below which throw stops
const DEBUG_LINE_VISUAL_SCALE = 0.1;      // Scales potential throw speed to debug line length

// New Friction Constants
const FRICTION_FACTOR_HIGH_SPEED = 0.2;    // Friction factor at high speeds
const FRICTION_FACTOR_LOW_SPEED = 1.5;     // Friction factor at low speeds (stronger stop)
const FRICTION_TRANSITION_MAX_SPEED = 200.0; // Speed above which high_speed_factor is fully active

const BOUNDARY_PADDING = 50; // Added padding constant

const IsConnected = trait({ value: false });
const Hand = trait({ value: null as string | null });
const HapticsAvailable = trait({ value: null as boolean | null });
const TouchScreenRes = trait({ value: null as TouchScreenResolution | null });
const BatteryPercentage = trait({ value: null as number | null });
const LastTapTime = trait({ value: null as Date | null });
const GestureProb = trait({ value: null as GestureProbDetail | null });
const ArmDirection = trait({ value: null as Vector2 | null });
const Acceleration = trait({ value: null as Vector3 | null });
const AngularVelocity = trait({ value: null as Vector3 | null });
const GravityVector = trait({ value: null as Vector3 | null });
const Orientation = trait({ value: null as Vector4 | null });
const TouchPosition = trait({ value: null as Vector2 | null });
const LastTouchEvent = trait({ value: null as string | null });
const RotaryStep = trait({ value: null as number | null });
const LastButtonPressTime = trait({ value: null as Date | null });

const MousePosition = trait({ x: 0, y: 0 });
const MouseVelocity = trait({ x: 0, y: 0 });
const IsThrown = trait({ value: false });
const ArmDirectionHistory = trait({ samples: [] as { dx: number; dy: number; timestamp: number }[] });

export const world = createWorld();

function WatchManager({ watchEntity }: { watchEntity: Entity }) {
  const sdkWatch = useMemo(() => new Watch(), []); 
  const connectButtonContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (connectButtonContainerRef.current) {
      while (connectButtonContainerRef.current.firstChild) {
        connectButtonContainerRef.current.removeChild(connectButtonContainerRef.current.firstChild);
      }
      const connectButton = sdkWatch.createConnectButton();
      if (connectButton && connectButtonContainerRef.current) {
        connectButtonContainerRef.current.appendChild(connectButton);
      }
    }

    const handleConnected = () => {
      watchEntity.set(IsConnected, { value: true });
      watchEntity.set(Hand, { value: sdkWatch.hand });
      watchEntity.set(HapticsAvailable, { value: sdkWatch.hapticsAvailable });
      watchEntity.set(TouchScreenRes, { value: sdkWatch.touchScreenResolution });
      watchEntity.set(BatteryPercentage, { value: sdkWatch.batteryPercentage });
    };

    const tapListener = () => {
      watchEntity.set(LastTapTime, { value: new Date() });
      
      const isThrownTrait = watchEntity.get(IsThrown);
      const currentIsThrown = isThrownTrait ? isThrownTrait.value : false;

      if (!currentIsThrown) {
        let throwDx = 0;
        let throwDy = 0;
        const tapTime = Date.now();

        const historyTrait = watchEntity.get(ArmDirectionHistory);
        const recentSamples = (historyTrait?.samples || []).filter(
          sample => tapTime - sample.timestamp <= THROW_GESTURE_WINDOW_MS && tapTime - sample.timestamp >= 0 // ensure samples are not from future if clocks are weird
        );

        if (recentSamples.length > 0) {
          let sumDx = 0;
          let sumDy = 0;
          for (const sample of recentSamples) {
            sumDx += sample.dx;
            sumDy += sample.dy;
          }
          throwDx = sumDx / recentSamples.length;
          throwDy = sumDy / recentSamples.length;
          console.log(`[TapListener] Using averaged history for throw. Samples in window (${THROW_GESTURE_WINDOW_MS}ms): ${recentSamples.length}. Avg Dx: ${throwDx.toFixed(3)}, Dy: ${throwDy.toFixed(3)}`);
        }
        
        // Fallback to instantaneous if history is insufficient or resulted in zero movement
        if (throwDx === 0 && throwDy === 0) {
          const armDirectionTrait = watchEntity.get(ArmDirection);
          const armDirectionValue = armDirectionTrait ? armDirectionTrait.value : null;
          if (armDirectionValue) {
            throwDx = armDirectionValue.x;
            throwDy = armDirectionValue.y;
            console.log('[TapListener] Using instantaneous ArmDirection for throw. Dx:', throwDx, 'Dy:', throwDy);
          }
        }

        if (throwDx !== 0 || throwDy !== 0) {
          const initialVelocity = {
            x: throwDx * THROW_SPEED_SCALE,
            y: throwDy * THROW_SPEED_SCALE, 
          };
          console.log('[TapListener] Attempting to THROW. Final Dir: (', throwDx.toFixed(3), ',', throwDy.toFixed(3), ') Initial Velocity:', initialVelocity);
          watchEntity.set(MouseVelocity, initialVelocity);
          watchEntity.set(IsThrown, { value: true });
        } else {
          console.log('[TapListener] Attempting to THROW, but arm direction is zero (either from history or instantaneous).');
        }
      } else {
        console.log('[TapListener] Attempting to CATCH. Current IsThrown:', currentIsThrown);
        watchEntity.set(MouseVelocity, { x: 0, y: 0 });
        watchEntity.set(IsThrown, { value: false });
      }
    };

    const probabilityListener = (event: CustomEvent) => { watchEntity.set(GestureProb, { value: event.detail }); };
    const armDirectionListener = (event: CustomEvent) => {
      const { dx, dy } = event.detail;
      watchEntity.set(ArmDirection, { value: { x: dx, y: dy } });

      const historyTrait = watchEntity.get(ArmDirectionHistory);
      let currentSamples = historyTrait?.samples ? [...historyTrait.samples] : [];

      currentSamples.push({ dx, dy, timestamp: Date.now() });

      const now = Date.now();
      currentSamples = currentSamples.filter(sample => now - sample.timestamp <= ARM_DIRECTION_HISTORY_MAX_AGE_MS);

      watchEntity.set(ArmDirectionHistory, { samples: currentSamples });
    };
    const accelerationListener = (event: CustomEvent) => { watchEntity.set(Acceleration, { value: event.detail }); };
    const angularVelocityListener = (event: CustomEvent) => { watchEntity.set(AngularVelocity, { value: event.detail }); };
    const gravityVectorListener = (event: CustomEvent) => { watchEntity.set(GravityVector, { value: event.detail }); };
    const orientationListener = (event: CustomEvent) => { watchEntity.set(Orientation, { value: event.detail }); };
    const touchStartListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchstart' }); };
    const touchMoveListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchmove' }); };
    const touchEndListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchend' }); };
    const touchCancelListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchcancel' }); };
    const rotaryListener = (event: CustomEvent) => { watchEntity.set(RotaryStep, { value: event.detail.step }); };
    const buttonListener = () => { watchEntity.set(LastButtonPressTime, { value: new Date() }); };

    sdkWatch.addEventListener('connected', handleConnected);
    sdkWatch.addEventListener('tap', tapListener);
    sdkWatch.addEventListener('probability', probabilityListener as EventListener);
    sdkWatch.addEventListener('armdirectionchanged', armDirectionListener as EventListener);
    sdkWatch.addEventListener('accelerationchanged', accelerationListener as EventListener);
    sdkWatch.addEventListener('angularvelocitychanged', angularVelocityListener as EventListener);
    sdkWatch.addEventListener('gravityvectorchanged', gravityVectorListener as EventListener);
    sdkWatch.addEventListener('orientationchanged', orientationListener as EventListener);
    sdkWatch.addEventListener('touchstart', touchStartListener as EventListener);
    sdkWatch.addEventListener('touchmove', touchMoveListener as EventListener);
    sdkWatch.addEventListener('touchend', touchEndListener as EventListener);
    sdkWatch.addEventListener('touchcancel', touchCancelListener as EventListener);
    sdkWatch.addEventListener('rotary', rotaryListener as EventListener);
    sdkWatch.addEventListener('button', buttonListener);

    return () => {
      sdkWatch.removeEventListener('connected', handleConnected);
      sdkWatch.removeEventListener('tap', tapListener);
      sdkWatch.removeEventListener('probability', probabilityListener as EventListener);
      sdkWatch.removeEventListener('armdirectionchanged', armDirectionListener as EventListener);
      sdkWatch.removeEventListener('accelerationchanged', accelerationListener as EventListener);
      sdkWatch.removeEventListener('angularvelocitychanged', angularVelocityListener as EventListener);
      sdkWatch.removeEventListener('gravityvectorchanged', gravityVectorListener as EventListener);
      sdkWatch.removeEventListener('orientationchanged', orientationListener as EventListener);
      sdkWatch.removeEventListener('touchstart', touchStartListener as EventListener);
      sdkWatch.removeEventListener('touchmove', touchMoveListener as EventListener);
      sdkWatch.removeEventListener('touchend', touchEndListener as EventListener);
      sdkWatch.removeEventListener('touchcancel', touchCancelListener as EventListener);
      sdkWatch.removeEventListener('rotary', rotaryListener as EventListener);
      sdkWatch.removeEventListener('button', buttonListener);
    };
  }, [sdkWatch, watchEntity]);

  const isConnectedValue = useTrait(watchEntity, IsConnected)?.value;
  const hapticsAvailableValue = useTrait(watchEntity, HapticsAvailable)?.value;

  const triggerHaptics = () => {
    if (sdkWatch && isConnectedValue && hapticsAvailableValue) {
      sdkWatch.triggerHaptics(0.7, 100);
    } else {
      globalThis.alert('Haptics not available or watch not connected.');
    }
  };

  return (
    <>
      <div ref={connectButtonContainerRef} style={{ marginBottom: '20px' }}></div>
      <button type="button" onClick={triggerHaptics} disabled={!hapticsAvailableValue || !isConnectedValue} style={{ marginTop: '10px' }}>Trigger Haptics</button>
    </>
  );
}

function R3FMouseCursor({ entity }: { entity: Entity }) {
  const meshRef = useRef<THREE.Mesh>(null!); 
  const isThrownStateHook = useTrait(entity, IsThrown); // For reactive color change
  const isCurrentlyThrownForColor = isThrownStateHook ? isThrownStateHook.value : false;

  useFrame((_, delta) => {
    if (!meshRef.current || !entity) {
      // console.log('[R3FMouseCursor] Missing refs or Koota, skipping frame.');
      return;
    }

    const kootaPosition = entity.get(MousePosition);
    const kootaVelocity = entity.get(MouseVelocity); // Snapshot of velocity for this frame's logic
    const isThrownState = entity.get(IsThrown);   // Snapshot of IsThrown for this frame's logic

    if (!kootaPosition || !kootaVelocity || !isThrownState) {
      // console.log('[R3FMouseCursor] Missing Koota data, skipping frame.');
      return;
    }
    //console.log('[R3FMouseCursor] Frame Start - Koota Pos:', kootaPosition, 'Vel:', kootaVelocity, 'IsThrown:', isThrownState.value);

    let newKootaX = kootaPosition.x;
    let newKootaY = kootaPosition.y;
    let newKootaVelX = kootaVelocity.x;
    let newKootaVelY = kootaVelocity.y;

    if (isThrownState.value) { // Only apply physics if currently in "thrown" state
      newKootaX += newKootaVelX * delta;
      newKootaY += newKootaVelY * delta;

      const currentSpeed = Math.sqrt(newKootaVelX**2 + newKootaVelY**2);

      // Dynamic friction calculation
      let dynamicFrictionFactor;
      if (currentSpeed <= MIN_THROW_SPEED_THRESHOLD) { // Should already be caught by speed check below, but defensive
        dynamicFrictionFactor = FRICTION_FACTOR_LOW_SPEED;
      } else if (currentSpeed >= FRICTION_TRANSITION_MAX_SPEED) {
        dynamicFrictionFactor = FRICTION_FACTOR_HIGH_SPEED;
      } else {
        // Interpolate between MIN_THROW_SPEED_THRESHOLD and FRICTION_TRANSITION_MAX_SPEED
        const speedRatio = (currentSpeed - MIN_THROW_SPEED_THRESHOLD) / (FRICTION_TRANSITION_MAX_SPEED - MIN_THROW_SPEED_THRESHOLD);
        dynamicFrictionFactor = FRICTION_FACTOR_LOW_SPEED + (FRICTION_FACTOR_HIGH_SPEED - FRICTION_FACTOR_LOW_SPEED) * speedRatio;
      }
      
      newKootaVelX *= (1 - dynamicFrictionFactor * delta); 
      newKootaVelY *= (1 - dynamicFrictionFactor * delta);

      // Check if speed is below threshold to stop the throw
      // Recalculate speed AFTER applying friction for this frame for the stop check
      const speedAfterFriction = Math.sqrt(newKootaVelX**2 + newKootaVelY**2);
      if (speedAfterFriction < MIN_THROW_SPEED_THRESHOLD) {
        //console.log('[R3FMouseCursor] Speed below threshold, stopping throw. Speed:', currentSpeed.toFixed(2));
        entity.set(IsThrown, { value: false }); // This will trigger re-render for color change via hook
        newKootaVelX = 0;
        newKootaVelY = 0;
      }

      // Boundary checks - with padding
      if (newKootaX < BOUNDARY_PADDING) { 
        newKootaX = BOUNDARY_PADDING; 
        newKootaVelX = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Left'); 
      }
      if (newKootaX > globalThis.innerWidth - BOUNDARY_PADDING) { 
        newKootaX = globalThis.innerWidth - BOUNDARY_PADDING; 
        newKootaVelX = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Right'); 
      }
      if (newKootaY < BOUNDARY_PADDING) { 
        newKootaY = BOUNDARY_PADDING; 
        newKootaVelY = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Top'); 
      }
      if (newKootaY > globalThis.innerHeight - BOUNDARY_PADDING) { 
        newKootaY = globalThis.innerHeight - BOUNDARY_PADDING; 
        newKootaVelY = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Bottom'); 
      }

      entity.set(MousePosition, { x: newKootaX, y: newKootaY });
      entity.set(MouseVelocity, { x: newKootaVelX, y: newKootaVelY });
    }
    meshRef.current.position.x = newKootaX - globalThis.innerWidth / 2;
    meshRef.current.position.y = -(newKootaY - globalThis.innerHeight / 2);
    //console.log('[R3FMouseCursor] Frame End - Mesh Pos X:', meshRef.current.position.x, 'Y:', meshRef.current.position.y);
  });

  const initialKootaPos = entity.get(MousePosition);
  const initialMeshX = initialKootaPos ? initialKootaPos.x - globalThis.innerWidth / 2 : 0;
  const initialMeshY = initialKootaPos ? -(initialKootaPos.y - globalThis.innerHeight / 2) : 0;

  return (
    <mesh ref={meshRef} position={[initialMeshX, initialMeshY, 0]}>
      <circleGeometry args={[30, 32]} /> 
      <meshBasicMaterial color={isCurrentlyThrownForColor ? "red" : "blue"} />
    </mesh>
  );
}

function DebugThrowVectorLine({ watchEntity }: { watchEntity: Entity }) {
  const isThrownState = useTrait(watchEntity, IsThrown);
  const isCurrentlyThrown = isThrownState ? isThrownState.value : false;
  const [linePoints, setLinePoints] = useState<[THREE.Vector3, THREE.Vector3]>([
    new THREE.Vector3(0,0,0.1),
    new THREE.Vector3(0,0,0.1)
  ]);

  useFrame(() => {
    if (!watchEntity) {
      // If no entity, perhaps ensure linePoints result in no visible line or an empty/default state
      // For now, if isCurrentlyThrown is true, it will be invisible anyway.
      return;
    }
    if (isCurrentlyThrown) {
        // Line is hidden by visible prop, no action needed here for points if it shouldn't update when hidden
        return;
    }
    // if (lineRef.current) lineRef.current.visible = true; // Removed ref usage

    let potentialDx = 0;
    let potentialDy = 0;
    const tapTime = Date.now();
    const historyTrait = watchEntity.get(ArmDirectionHistory);
    const currentArmDir = watchEntity.get(ArmDirection); // For fallback

    const recentSamples = (historyTrait?.samples || []).filter(
      sample => tapTime - sample.timestamp <= THROW_GESTURE_WINDOW_MS && tapTime - sample.timestamp >= 0
    );

    if (recentSamples.length > 0) {
      let sumDx = 0;
      let sumDy = 0;
      for (const sample of recentSamples) {
        sumDx += sample.dx;
        sumDy += sample.dy;
      }
      potentialDx = sumDx / recentSamples.length;
      potentialDy = sumDy / recentSamples.length;
    }
    
    if ((potentialDx === 0 && potentialDy === 0) && currentArmDir?.value) {
      potentialDx = currentArmDir.value.x;
      potentialDy = currentArmDir.value.y;
    }

    const kootaMousePos = watchEntity.get(MousePosition);
    if (!kootaMousePos) {
      // lineRef.current.visible = false; // Removed ref usage
      return;
    }

    const startX_r3f = kootaMousePos.x - globalThis.innerWidth / 2;
    const startY_r3f = -(kootaMousePos.y - globalThis.innerHeight / 2);

    const vecX_r3f = potentialDx * THROW_SPEED_SCALE * DEBUG_LINE_VISUAL_SCALE;
    const vecY_r3f = -(potentialDy * THROW_SPEED_SCALE * DEBUG_LINE_VISUAL_SCALE); // Y is inverted

    const endX_r3f = startX_r3f + vecX_r3f;
    const endY_r3f = startY_r3f + vecY_r3f;
    
    const points: [THREE.Vector3, THREE.Vector3] = [
      new THREE.Vector3(startX_r3f, startY_r3f, 0.1),
      new THREE.Vector3(endX_r3f, endY_r3f, 0.1)
    ];
    // if (lineRef.current.geometry) { // No longer needed if DreiLine takes points prop
    //     lineRef.current.geometry.setFromPoints(points);
    //     lineRef.current.geometry.attributes.position.needsUpdate = true;
    // }
    setLinePoints(points); // Update state for DreiLine points prop
  });

  // Initialize geometry once - No longer needed with DreiLine points prop
  // const lineGeom = useMemo(() => new THREE.BufferGeometry().setFromPoints([
  //   new THREE.Vector3(0,0,0.1), new THREE.Vector3(0,0,0.1)
  // ]), []);

  return (
    // <line ref={lineRef} geometry={lineGeom} visible={false}> 
    //   <lineBasicMaterial color="yellow" />
    // </line>
    <DreiLine 
        // ref={lineRef} // Removed ref
        points={linePoints} 
        color="yellow" 
        lineWidth={3} 
        visible={!isCurrentlyThrown && !!watchEntity} // Also ensure watchEntity exists for visibility
    />
  );
}

export function VirtualMouse({ entity }: { entity: Entity }) {
  const [screenSize, setScreenSize] = useState({ width: globalThis.innerWidth, height: globalThis.innerHeight });

  useEffect(() => {
    const handleResize = () => {
      const newWidth = globalThis.innerWidth;
      const newHeight = globalThis.innerHeight;
      setScreenSize({ width: newWidth, height: newHeight });

      // Recenter mouse Koota position if it's not currently thrown
      if (entity) {
        const isThrownState = entity.get(IsThrown);
        // Ensure isThrownState exists and its value is false
        if (isThrownState && !isThrownState.value) { 
          entity.set(MousePosition, { x: newWidth / 2, y: newHeight / 2 });
          // Optionally, ensure velocity is also zero if it was caught but had residual velocity somehow
          // entity.set(MouseVelocity, { x: 0, y: 0 }); 
        }
      }
    };
    globalThis.addEventListener('resize', handleResize);
    // Call handleResize once initially to set correct initial size and position if needed
    // handleResize(); // Consider if this is needed or if initial spawn position is sufficient
    return () => globalThis.removeEventListener('resize', handleResize);
  }, [entity]); // Added entity to the dependency array
  

  return (
    <Canvas 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 9999
      }}
    >
      <OrthographicCamera 
        makeDefault
        left={-screenSize.width / 2} // Corrected
        right={screenSize.width / 2}  // Corrected
        top={screenSize.height / 2}   // Corrected
        bottom={-screenSize.height / 2} // Corrected
        near={1}
        far={1000} 
        position={[0, 0, 10]} 
      />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />

      entity && <R3FMouseCursor entity={entity} />
      entity && <DebugThrowVectorLine watchEntity={entity} />
      {/* Visual Boundary Box */}
      <mesh>
        <boxGeometry args={[screenSize.width - 2 * BOUNDARY_PADDING, screenSize.height - 2 * BOUNDARY_PADDING, 0]} /> 
        <meshBasicMaterial opacity={0} transparent />
        <Edges color="cyan" lineWidth={10} />
      </mesh>

    </Canvas>
  );
}

function WatchInfoDisplay({ watchEntity }: { watchEntity: Entity }) {
  const isConnected = useTrait(watchEntity, IsConnected)?.value;
  const hand = useTrait(watchEntity, Hand)?.value;
  const hapticsAvailable = useTrait(watchEntity, HapticsAvailable)?.value;
  const touchScreenResolution = useTrait(watchEntity, TouchScreenRes)?.value;
  const batteryPercentage = useTrait(watchEntity, BatteryPercentage)?.value;
  const lastTap = useTrait(watchEntity, LastTapTime)?.value;
  const gestureProbability = useTrait(watchEntity, GestureProb)?.value;
  const armDirection = useTrait(watchEntity, ArmDirection)?.value;
  const acceleration = useTrait(watchEntity, Acceleration)?.value;
  const angularVelocity = useTrait(watchEntity, AngularVelocity)?.value;
  const gravityVector = useTrait(watchEntity, GravityVector)?.value;
  const orientation = useTrait(watchEntity, Orientation)?.value;
  const lastTouchEvent = useTrait(watchEntity, LastTouchEvent)?.value;
  const touchPosition = useTrait(watchEntity, TouchPosition)?.value;
  const rotaryStep = useTrait(watchEntity, RotaryStep)?.value;
  const lastButtonPress = useTrait(watchEntity, LastButtonPressTime)?.value;

  return (
    <div className="card">
      <div>Status: {isConnected ? 'Connected' : 'Disconnected'}</div>
      {isConnected && (
        <>
          <div>Hand: {hand ?? 'N/A'}</div>
          <div>Haptics Available: {typeof hapticsAvailable === 'boolean' ? hapticsAvailable.toString() : 'N/A'}</div>
          <div>Touch Screen: {touchScreenResolution ? `${touchScreenResolution.width}x${touchScreenResolution.height}` : 'N/A'}</div>
          <div>Battery: {batteryPercentage === null ? 'N/A' : `${batteryPercentage}%`}</div>
        </>
      )}
      <h3>Events Data:</h3>
      <div>Last Tap: {lastTap ? lastTap.toLocaleTimeString() : 'N/A'}</div>
      <div>Gesture Probability: {gestureProbability ? JSON.stringify(gestureProbability) : 'N/A'}</div>
      <div>Arm Direction: {armDirection ? `x: ${armDirection.x.toFixed(2)}, y: ${armDirection.y.toFixed(2)}` : 'N/A'}</div>
      <div>Acceleration: {acceleration ? `x: ${acceleration.x.toFixed(2)}, y: ${acceleration.y.toFixed(2)}, z: ${acceleration.z.toFixed(2)}` : 'N/A'}</div>
      <div>Angular Velocity: {angularVelocity ? `x: ${angularVelocity.x.toFixed(2)}, y: ${angularVelocity.y.toFixed(2)}, z: ${angularVelocity.z.toFixed(2)}` : 'N/A'}</div>
      <div>Gravity Vector: {gravityVector ? `x: ${gravityVector.x.toFixed(2)}, y: ${gravityVector.y.toFixed(2)}, z: ${gravityVector.z.toFixed(2)}` : 'N/A'}</div>
      <div>Orientation: {orientation ? `x: ${orientation.x.toFixed(2)}, y: ${orientation.y.toFixed(2)}, z: ${orientation.z.toFixed(2)}, w: ${orientation.w.toFixed(2)}` : 'N/A'}</div>
      <div>Last Touch Event: {lastTouchEvent ?? 'N/A'} {touchPosition ? `(x: ${touchPosition.x}, y: ${touchPosition.y})` : ''}</div>
      <div>Rotary Step: {rotaryStep === null ? 'N/A' : rotaryStep}</div>
      <div>Last Button Press: {lastButtonPress ? lastButtonPress.toLocaleTimeString() : 'N/A'}</div>
    </div>
  );
}

function AppContent() {
  const worldInstance = useWorld();

  const watchEntity = useMemo(() => {
    const existing = worldInstance.query(IsConnected, Hand, MousePosition); 
    if (existing.length > 0) return existing[0];
    
    return worldInstance.spawn(
      IsConnected, Hand, HapticsAvailable, TouchScreenRes, BatteryPercentage,
      LastTapTime, GestureProb, ArmDirection, Acceleration, AngularVelocity,
      GravityVector, Orientation, TouchPosition, LastTouchEvent, RotaryStep, LastButtonPressTime,
      MousePosition({ x: globalThis.innerWidth / 2, y: globalThis.innerHeight / 2 }), 
      MouseVelocity, 
      IsThrown,
      ArmDirectionHistory // Add new trait here
    );
  }, [worldInstance]);

  return (
    <>
      <WatchManager watchEntity={watchEntity} />
      <VirtualMouse entity={watchEntity} /> 
      <h2>Touch SDK Watch Info</h2>
      <WatchInfoDisplay watchEntity={watchEntity} />
    </>
  );
}

function App() {
  return (
    <WorldProvider world={world}>
      <AppContent />
    </WorldProvider>
  );
}

export default App;
