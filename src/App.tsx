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

const ARM_DIRECTION_HISTORY_MAX_AGE_MS = 200; // Max age of samples in history (increased for lookahead)
const MIN_THROW_SPEED_THRESHOLD = 5.0;    // Speed (pixels/sec) below which throw stops
const DEBUG_LINE_VISUAL_SCALE = 0.1;      // Scales potential throw speed to debug line length
const TAP_ACTION_DEBOUNCE_MS = 100;       // Debounce time for tap/flick actions

// Updated Friction Constants (from user Step 152)
const FRICTION_FACTOR_HIGH_SPEED = 1.4;    // Friction factor at high speeds
const FRICTION_FACTOR_LOW_SPEED = 6.0;     // Friction factor at low speeds (stronger stop)
const FRICTION_TRANSITION_MAX_SPEED = 300.0; // Speed above which high_speed_factor is fully active

const FLICK_SENSITIVITY_EXPONENT = 3.0;   // Makes flick sensitivity slider more responsive at high values
const FLICK_SENSITIVITY_UI_QUADRATIC_A = -1.8; // Coefficient for s_ui^2
const FLICK_SENSITIVITY_UI_QUADRATIC_B = 2.8;  // Coefficient for s_ui
const BOUNDARY_PADDING = 50; // Added padding constant

// Koota traits for configuration
const ConfigurableThrowWindowMs = trait({ value: 50 }); 
const ShowDebugLine = trait({ value: false }); 
const ConfigurableThrowStrength = trait({ value: 500 }); // New trait for throw strength
const FlickSensitivity = trait({ value: 0.0 });          // New trait for flick sensitivity (0.0 to 1.0)
const ConfigurableLookaheadDelayMs = trait({ value: 30 }); // New trait for lookahead delay
const IsThrowPending = trait({ value: false });           // True if waiting for lookahead to complete for a throw

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

let lastTapActionTimestamp = 0; // For debouncing SDK tap vs. Flick-tap

const executeActualThrowLogic = (watchEntity: Entity, tapTimestamp: number) => {
  console.log(`[executeActualThrowLogic] Called. TapTimestamp: ${tapTimestamp}`);

  // If the mouse is already considered thrown by Koota state (e.g., caught during lookahead), abort this throw.
  // This function is meant to *initiate* a throw, so IsThrown should be false at its start.
  if (watchEntity.get(IsThrown)?.value === true) {
      console.log('[executeActualThrowLogic] Mouse is already marked as thrown (e.g., caught during lookahead). Aborting this throw attempt.');
      // IsThrowPending will be cleared by the setTimeout callback that called this.
      return;
  }

  const currentThrowStrength = watchEntity.get(ConfigurableThrowStrength)?.value ?? 500;
  const configurableThrowWindowMs = watchEntity.get(ConfigurableThrowWindowMs)?.value ?? 50;
  // Get the lookaheadDelay that was active when the throw was initiated, passed via tapTimestamp context.
  // For calculating sample window, we re-fetch. This could be passed if strictness is needed.
  const lookaheadDelayMs = watchEntity.get(ConfigurableLookaheadDelayMs)?.value ?? 0; 
  const history = watchEntity.get(ArmDirectionHistory);

  const historyStartTime = tapTimestamp - configurableThrowWindowMs;
  const historyEndTime = tapTimestamp + lookaheadDelayMs; 

  console.log(`[executeActualThrowLogic] Calculating throw. Strength: ${currentThrowStrength}, ThrowWindow: ${configurableThrowWindowMs}ms, LookaheadForSampleEnd: ${lookaheadDelayMs}ms`);
  console.log(`[executeActualThrowLogic] Sample Window (epoch relative): ${historyStartTime} to ${historyEndTime}`);

  const recentSamples = (history?.samples || []).filter(
    sample => sample.timestamp >= historyStartTime && sample.timestamp <= historyEndTime
  );
  console.log(`[executeActualThrowLogic] Found ${recentSamples.length} samples in window.`);
  if (recentSamples.length > 0 && recentSamples.length <= 5) {
      console.log('[executeActualThrowLogic] Samples:', recentSamples.map(s => ({dx:s.dx.toFixed(2), dy:s.dy.toFixed(2), ts_delta: s.timestamp - tapTimestamp })));
  } else if (recentSamples.length > 5) {
      console.log('[executeActualThrowLogic] First 5 (of '+recentSamples.length+') samples:', recentSamples.slice(0,5).map(s => ({dx:s.dx.toFixed(2), dy:s.dy.toFixed(2), ts_delta: s.timestamp - tapTimestamp })));
  }

  let throwDx = 0;
  let throwDy = 0;

  if (recentSamples.length > 0) {
    let sumDx = 0;
    let sumDy = 0;
    for (const sample of recentSamples) {
      sumDx += sample.dx;
      sumDy += sample.dy;
    }
    throwDx = sumDx / recentSamples.length;
    throwDy = sumDy / recentSamples.length;
    console.log(`[executeActualThrowLogic] Using averaged history. Raw Dx:${throwDx.toFixed(3)}, Dy:${throwDy.toFixed(3)}`);
  } else {
    const armDir = watchEntity.get(ArmDirection)?.value;
    console.log('[executeActualThrowLogic] No history samples in window. Fallback ArmDirection value:', armDir);
    if (armDir && typeof armDir.x === 'number' && typeof armDir.y === 'number') {
      throwDx = armDir.x;
      throwDy = armDir.y;
      console.log(`[executeActualThrowLogic] Using instantaneous ArmDirection. Raw Dx:${throwDx.toFixed(3)}, Dy:${throwDy.toFixed(3)}`);
    } else {
      console.log('[executeActualThrowLogic] No valid arm direction data. Cannot throw.');
      watchEntity.set(IsThrown, { value: false }); // Ensure it remains not thrown
      return; 
    }
  }

  console.log(`[executeActualThrowLogic] Final Raw Vector: Dx:${throwDx.toFixed(3)}, Dy:${throwDy.toFixed(3)}`);

  if (throwDx === 0 && throwDy === 0) {
      console.log('[executeActualThrowLogic] Calculated throw vector is zero. Mouse remains stationary.');
      watchEntity.set(IsThrown, { value: false }); 
      watchEntity.set(MouseVelocity, { x: 0, y: 0 });
      return;
  }

  const finalVelX = throwDx * currentThrowStrength;
  const finalVelY = throwDy * currentThrowStrength;

  watchEntity.set(MouseVelocity, { x: finalVelX, y: finalVelY });
  watchEntity.set(IsThrown, { value: true });
  console.log(`[executeActualThrowLogic] Mouse Thrown! Velocity: x:${finalVelX.toFixed(2)}, y:${finalVelY.toFixed(2)}`);
};

// Refactored core tap/throw/catch logic
function performThrowOrCatchAction(watchEntity: Entity) {
  const now = Date.now();
  if (now - lastTapActionTimestamp < TAP_ACTION_DEBOUNCE_MS) {
    console.log('[performThrowOrCatchAction] Debounced due to rapid action.');
    return; 
  }
  lastTapActionTimestamp = now;

  if (watchEntity.get(IsThrowPending)?.value) {
    console.log('[performThrowOrCatchAction] Action ignored, throw already pending from lookahead.');
    return;
  }

  const isCurrentlyThrown = watchEntity.get(IsThrown)?.value ?? false;
  console.log(`[performThrowOrCatchAction] Action initiated. IsCurrentlyThrown: ${isCurrentlyThrown}`);

  if (isCurrentlyThrown) {
    // Catch the mouse - This action is immediate
    watchEntity.set(IsThrown, { value: false });
    watchEntity.set(MouseVelocity, { x: 0, y: 0 });
    console.log('[performThrowOrCatchAction] Mouse Caught (was thrown).');
    // If a throw was pending, this catch effectively cancels it.
    if (watchEntity.get(IsThrowPending)?.value) {
        console.log('[performThrowOrCatchAction] Catch occurred while a throw was pending; clearing pending state.');
        watchEntity.set(IsThrowPending, { value: false });
        // Note: The setTimeout for the pending throw will still fire, but executeActualThrowLogic should check IsThrown.
    }
  } else {
    // Attempt to Throw the mouse
    const tapTimestamp = Date.now();
    const lookaheadDelayMs = watchEntity.get(ConfigurableLookaheadDelayMs)?.value ?? 0;
    
    console.log(`[performThrowOrCatchAction] Attempting throw. TapTime: ${tapTimestamp}, LookaheadDelayMs: ${lookaheadDelayMs}`);

    if (lookaheadDelayMs > 0) {
      watchEntity.set(IsThrowPending, { value: true });
      console.log(`[performThrowOrCatchAction] Scheduling throw logic after ${lookaheadDelayMs}ms for lookahead.`);
      setTimeout(() => {
        console.log('[performThrowOrCatchAction] setTimeout: Executing delayed throw logic.');
        // Only execute if still pending. A catch might have cleared IsThrowPending.
        if (watchEntity.get(IsThrowPending)?.value) {
            executeActualThrowLogic(watchEntity, tapTimestamp);
        }
        watchEntity.set(IsThrowPending, { value: false });
        console.log('[performThrowOrCatchAction] setTimeout: Lookahead processing complete, IsThrowPending set to false.');
      }, lookaheadDelayMs);
    } else {
      // Execute immediately if no lookahead delay
      console.log('[performThrowOrCatchAction] Executing throw logic immediately (no lookahead).');
      executeActualThrowLogic(watchEntity, tapTimestamp);
    }
  }
}

function WatchManager({ watchEntity }: { watchEntity: Entity }) {
  const sdkWatchRef = useRef<Watch | null>(null);
  const connectButtonContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const watch = new Watch(); // Reverted from Watch.getInstance()
    sdkWatchRef.current = watch;
    if (connectButtonContainerRef.current) {
      // Clear existing button before rendering a new one
      while (connectButtonContainerRef.current.firstChild) {
        connectButtonContainerRef.current.removeChild(connectButtonContainerRef.current.firstChild);
      }
      const connectButton = watch.createConnectButton();
      if (connectButton) {
        connectButtonContainerRef.current.appendChild(connectButton);
      }
    }

    const handleConnected = () => {
      watchEntity.set(IsConnected, { value: true });
      if (sdkWatchRef.current) { // Ensure watch instance exists
        watchEntity.set(Hand, { value: sdkWatchRef.current.hand });
        watchEntity.set(HapticsAvailable, { value: sdkWatchRef.current.hapticsAvailable });
        watchEntity.set(TouchScreenRes, { value: sdkWatchRef.current.touchScreenResolution });
        watchEntity.set(BatteryPercentage, { value: sdkWatchRef.current.batteryPercentage });
      }
    };
    const handleDisconnected = () => watchEntity.set(IsConnected, { value: false });

    // SDK Tap listener
    const tapListener = () => {
      console.log('[WatchManager] SDK tap event received.');
      performThrowOrCatchAction(watchEntity);
    };

    const probabilityListener = (event: CustomEvent<GestureProbDetail>) => {
      const gestureProb = event.detail;
      watchEntity.set(GestureProb, { value: gestureProb });

      // Flick-tap detection based on probability
      const currentFlickSensitivityUI = watchEntity.get(FlickSensitivity)?.value ?? 0;
      if (currentFlickSensitivityUI > 0) { // Only apply flick logic if sensitivity is non-zero
        const tapProbability = gestureProb?.tap ?? 0;
        
        // Apply quadratic mapping to UI sensitivity
        // s_internal = a * s_ui^2 + b * s_ui
        // Values chosen so s_ui=0 -> s_internal=0, s_ui=0.5 -> s_internal=0.95, s_ui=1 -> s_internal=1
        const flickSensitivityInternal = (FLICK_SENSITIVITY_UI_QUADRATIC_A * Math.pow(currentFlickSensitivityUI, 2)) + (FLICK_SENSITIVITY_UI_QUADRATIC_B * currentFlickSensitivityUI);
        // Clamp internal sensitivity to [0, 1] just in case coefficients produce out-of-range values
        const clampedFlickSensitivityInternal = Math.max(0, Math.min(1, flickSensitivityInternal));

        // Threshold goes from 1 (sens=0) down to 0 (sens=1)
        const probabilityThreshold = Math.pow(1.0 - clampedFlickSensitivityInternal, FLICK_SENSITIVITY_EXPONENT);
        
        if (tapProbability >= probabilityThreshold) { 
          console.log(`[WatchManager] Flick-tap detected! Prob: ${tapProbability.toFixed(3)} >= Thresh: ${probabilityThreshold.toFixed(5)} (UI Sens: ${currentFlickSensitivityUI.toFixed(2)}, Internal Sens: ${clampedFlickSensitivityInternal.toFixed(2)}, Exp: ${FLICK_SENSITIVITY_EXPONENT})`);
          performThrowOrCatchAction(watchEntity);
        }
      }
    };

    const armDirectionListener = (event: CustomEvent<{ dx: number; dy: number }>) => { 
      const eventData = event.detail;
      // Ensure that eventData and its dx, dy properties are valid numbers
      if (eventData && typeof eventData.dx === 'number' && typeof eventData.dy === 'number') {
        // Set ArmDirection trait with x and y properties, using dx/dy from event
        watchEntity.set(ArmDirection, { value: { x: eventData.dx, y: eventData.dy } });

        const historyTrait = watchEntity.get(ArmDirectionHistory);
        let currentSamples = historyTrait?.samples ? [...historyTrait.samples] : [];

        // History samples directly use dx and dy from event
        currentSamples.push({ dx: eventData.dx, dy: eventData.dy, timestamp: Date.now() });

        const now = Date.now();
        currentSamples = currentSamples.filter(sample => now - sample.timestamp <= ARM_DIRECTION_HISTORY_MAX_AGE_MS);
        watchEntity.set(ArmDirectionHistory, { samples: currentSamples });
      } else {
        console.warn('[WatchManager] armDirectionListener received invalid or incomplete arm direction data:', eventData);
      }
    };
    const accelerationListener = (event: CustomEvent<Vector3>) => { watchEntity.set(Acceleration, { value: event.detail }); };
    const angularVelocityListener = (event: CustomEvent<Vector3>) => { watchEntity.set(AngularVelocity, { value: event.detail }); };
    const gravityVectorListener = (event: CustomEvent<Vector3>) => { watchEntity.set(GravityVector, { value: event.detail }); };
    const orientationListener = (event: CustomEvent<Vector4>) => { watchEntity.set(Orientation, { value: event.detail }); };
    const touchStartListener = (event: CustomEvent<Vector2>) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchstart' }); };
    const touchMoveListener = (event: CustomEvent<Vector2>) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchmove' }); };
    const touchEndListener = (event: CustomEvent<Vector2>) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchend' }); };
    const touchCancelListener = (event: CustomEvent<Vector2>) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchcancel' }); };
    const rotaryListener = (event: CustomEvent<{ step: number }>) => { watchEntity.set(RotaryStep, { value: event.detail.step }); };
    const buttonListener = () => { watchEntity.set(LastButtonPressTime, { value: new Date() }); };

    watch.addEventListener('connected', handleConnected);
    watch.addEventListener('disconnected', handleDisconnected);
    watch.addEventListener('tap', tapListener);
    watch.addEventListener('probability', probabilityListener as EventListener);
    watch.addEventListener('armdirectionchanged', armDirectionListener as EventListener);
    watch.addEventListener('accelerationchanged', accelerationListener as EventListener);
    watch.addEventListener('angularvelocitychanged', angularVelocityListener as EventListener);
    watch.addEventListener('gravityvectorchanged', gravityVectorListener as EventListener);
    watch.addEventListener('orientationchanged', orientationListener as EventListener);
    watch.addEventListener('touchstart', touchStartListener as EventListener);
    watch.addEventListener('touchmove', touchMoveListener as EventListener);
    watch.addEventListener('touchend', touchEndListener as EventListener);
    watch.addEventListener('touchcancel', touchCancelListener as EventListener);
    watch.addEventListener('rotary', rotaryListener as EventListener);
    watch.addEventListener('button', buttonListener);

    return () => {
      watch.removeEventListener('connected', handleConnected);
      watch.removeEventListener('disconnected', handleDisconnected);
      watch.removeEventListener('tap', tapListener);
      watch.removeEventListener('probability', probabilityListener as EventListener);
      watch.removeEventListener('armdirectionchanged', armDirectionListener as EventListener);
      watch.removeEventListener('accelerationchanged', accelerationListener as EventListener);
      watch.removeEventListener('angularvelocitychanged', angularVelocityListener as EventListener);
      watch.removeEventListener('gravityvectorchanged', gravityVectorListener as EventListener);
      watch.removeEventListener('orientationchanged', orientationListener as EventListener);
      watch.removeEventListener('touchstart', touchStartListener as EventListener);
      watch.removeEventListener('touchmove', touchMoveListener as EventListener);
      watch.removeEventListener('touchend', touchEndListener as EventListener);
      watch.removeEventListener('touchcancel', touchCancelListener as EventListener);
      watch.removeEventListener('rotary', rotaryListener as EventListener);
      watch.removeEventListener('button', buttonListener);
    };
  }, [watchEntity]); // Removed sdkWatchRef from dependency array as watch instance is stable within useEffect

  const isConnectedValue = useTrait(watchEntity, IsConnected)?.value;
  const hapticsAvailableValue = useTrait(watchEntity, HapticsAvailable)?.value;
  const flickSensitivityTrait = useTrait(watchEntity, FlickSensitivity);                // For UI
  const configurableLookaheadDelayMsTrait = useTrait(watchEntity, ConfigurableLookaheadDelayMs); // For UI
  const isThrowPendingTrait = useTrait(watchEntity, IsThrowPending); // For UI debug

  const triggerHaptics = () => {
    if (sdkWatchRef.current && isConnectedValue && hapticsAvailableValue) {
      sdkWatchRef.current.triggerHaptics(0.7, 100);
    } else {
      globalThis.alert('Haptics not available or watch not connected.');
    }
  };

  return (
    <>
      <div ref={connectButtonContainerRef} style={{ marginBottom: '20px' }}></div>
      <button type="button" onClick={triggerHaptics} disabled={!hapticsAvailableValue || !isConnectedValue} style={{ marginTop: '10px' }}>Trigger Haptics</button>
      {/* Debug display for IsThrowPending */}
      { (isThrowPendingTrait?.value) && <div style={{color: 'orange'}}>Throw Pending (Lookahead)...</div> }
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
  
  const configurableThrowWindow = useTrait(watchEntity, ConfigurableThrowWindowMs)?.value ?? 50;
  const showDebugLineSetting = useTrait(watchEntity, ShowDebugLine)?.value ?? false;
  const currentThrowStrength = useTrait(watchEntity, ConfigurableThrowStrength)?.value ?? 500;

  const [linePoints, setLinePoints] = useState<THREE.Vector3[]>([
    new THREE.Vector3(0,0,0.1),
    new THREE.Vector3(0,0,0.1)
  ]);

  useFrame(() => {
    if (!watchEntity) {
      return;
    }
    if (!showDebugLineSetting || isCurrentlyThrown) {
        // If not showing debug line or if mouse is thrown, ensure points are minimal to avoid rendering old line
        if (linePoints.length > 2 || linePoints[0].x !== 0 || linePoints[1].x !== 0) {
             setLinePoints([new THREE.Vector3(0,0,0.1), new THREE.Vector3(0,0,0.1)]);
        }
        return;
    }

    const kootaMousePos = watchEntity.get(MousePosition);
    if (!kootaMousePos) {
      return;
    }

    const startX_r3f = kootaMousePos.x - globalThis.innerWidth / 2;
    const startY_r3f = -(kootaMousePos.y - globalThis.innerHeight / 2);
    const startPoint = new THREE.Vector3(startX_r3f, startY_r3f, 0.1);
    const points: THREE.Vector3[] = [startPoint];

    const historyTrait = watchEntity.get(ArmDirectionHistory);
    const lookaheadDelayMs = watchEntity.get(ConfigurableLookaheadDelayMs)?.value ?? 0; // Get lookahead
    const tapTime = Date.now(); // Use current time for filtering samples relative to now

    // Filter samples considering throw window and lookahead
    // Samples should be WITHIN [tapTime - throwWindow, tapTime + lookaheadDelay]
    // For debug line, we are predicting a throw *now*, so we use tapTime as the reference.
    const historyStartTime = tapTime - configurableThrowWindow;
    const historyEndTime = tapTime + lookaheadDelayMs;

    const samplesToUse = (historyTrait?.samples || []).filter(
      sample => sample.timestamp >= historyStartTime && sample.timestamp <= historyEndTime
    );
    
    // Sort samples by timestamp to build the curve chronologically
    samplesToUse.sort((a, b) => a.timestamp - b.timestamp);

    if (samplesToUse.length > 0) {
      let currentX = startX_r3f;
      let currentY = startY_r3f;
      // Use a smaller scale factor per segment if there are many samples to avoid overly long lines
      // Or, we can average them as before for the *total* vector, but draw segments based on individual samples
      // For drawing a curve, we'll use individual sample directions sequentially.
      const numSamples = samplesToUse.length;
      const perSampleScale = DEBUG_LINE_VISUAL_SCALE / (numSamples > 1 ? Math.sqrt(numSamples) : 1); // Dampen effect of many small jitters

      for (const sample of samplesToUse) {
        const dx = sample.dx;
        const dy = sample.dy;

        // Scale each segment. Strength applied at the end of chain or averaged?
        // For visualization, direct scaling of each segment is simpler to show path.
        const vecX_r3f_segment = dx * currentThrowStrength * perSampleScale; 
        const vecY_r3f_segment = -(dy * currentThrowStrength * perSampleScale); // Y is inverted
        
        currentX += vecX_r3f_segment;
        currentY += vecY_r3f_segment;
        points.push(new THREE.Vector3(currentX, currentY, 0.1));
      }
      if (points.length === 1) { // Only start point was added, means no valid samples processed
          // Fallback to instantaneous arm direction if no history points were generated
          const currentArmDir = watchEntity.get(ArmDirection);
          if (currentArmDir?.value) {
            const vecX_r3f = currentArmDir.value.x * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE;
            const vecY_r3f = -(currentArmDir.value.y * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE);
            points.push(new THREE.Vector3(startX_r3f + vecX_r3f, startY_r3f + vecY_r3f, 0.1));
          } else {
            points.push(new THREE.Vector3(startX_r3f, startY_r3f, 0.1)); // Duplicate start if no arm dir
          }
      }
    } else {
      // Fallback to instantaneous arm direction if no history samples at all
      const currentArmDir = watchEntity.get(ArmDirection);
      let potentialDx = 0;
      let potentialDy = 0;
      if (currentArmDir?.value) {
        potentialDx = currentArmDir.value.x;
        potentialDy = currentArmDir.value.y;
      }
      const vecX_r3f = potentialDx * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE;
      const vecY_r3f = -(potentialDy * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE); // Y is inverted
      points.push(new THREE.Vector3(startX_r3f + vecX_r3f, startY_r3f + vecY_r3f, 0.1));
    }
    
    setLinePoints(points);
  });

  return (
    <DreiLine 
        points={linePoints} 
        color="yellow" 
        lineWidth={3} 
        visible={showDebugLineSetting && !isCurrentlyThrown && !!watchEntity && linePoints.length > 1}
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

  // Get new configurable traits for UI
  const configurableThrowWindowMsTrait = useTrait(watchEntity, ConfigurableThrowWindowMs);
  const showDebugLineTrait = useTrait(watchEntity, ShowDebugLine);
  const configurableThrowStrengthTrait = useTrait(watchEntity, ConfigurableThrowStrength); // For UI
  const flickSensitivityTrait = useTrait(watchEntity, FlickSensitivity);                // For UI
  const configurableLookaheadDelayMsTrait = useTrait(watchEntity, ConfigurableLookaheadDelayMs); // For UI

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
      <div>Arm Direction: {armDirection && typeof armDirection.x === 'number' && typeof armDirection.y === 'number' ? `x: ${armDirection.x.toFixed(2)}, y: ${armDirection.y.toFixed(2)}` : 'N/A'}</div>
      <div>Acceleration: {acceleration && typeof acceleration.x === 'number' && typeof acceleration.y === 'number' && typeof acceleration.z === 'number' ? `x: ${acceleration.x.toFixed(2)}, y: ${acceleration.y.toFixed(2)}, z: ${acceleration.z.toFixed(2)}` : 'N/A'}</div>
      <div>Angular Velocity: {angularVelocity && typeof angularVelocity.x === 'number' && typeof angularVelocity.y === 'number' && typeof angularVelocity.z === 'number' ? `x: ${angularVelocity.x.toFixed(2)}, y: ${angularVelocity.y.toFixed(2)}, z: ${angularVelocity.z.toFixed(2)}` : 'N/A'}</div>
      <div>Gravity Vector: {gravityVector && typeof gravityVector.x === 'number' && typeof gravityVector.y === 'number' && typeof gravityVector.z === 'number' ? `x: ${gravityVector.x.toFixed(2)}, y: ${gravityVector.y.toFixed(2)}, z: ${gravityVector.z.toFixed(2)}` : 'N/A'}</div>
      <div>Orientation: {orientation && typeof orientation.x === 'number' && typeof orientation.y === 'number' && typeof orientation.z === 'number' && typeof orientation.w === 'number' ? `x: ${orientation.x.toFixed(2)}, y: ${orientation.y.toFixed(2)}, z: ${orientation.z.toFixed(2)}, w: ${orientation.w.toFixed(2)}` : 'N/A'}</div>
      <div>Last Touch Event: {lastTouchEvent ?? 'N/A'} {touchPosition && typeof touchPosition.x === 'number' && typeof touchPosition.y === 'number' ? `(x: ${touchPosition.x}, y: ${touchPosition.y})` : ''}</div>
      <div>Rotary Step: {rotaryStep === null ? 'N/A' : rotaryStep}</div>
      <div>Last Button Press: {lastButtonPress ? lastButtonPress.toLocaleTimeString() : 'N/A'}</div>
      
      <h3>Settings:</h3>
      <div>
        Throw Gesture Window (ms):
        <input
          type="number"
          value={configurableThrowWindowMsTrait?.value ?? 50}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && watchEntity) {
              watchEntity.set(ConfigurableThrowWindowMs, { value: val });
            }
          }}
          min="0"
          step="10"
          style={{ marginLeft: '10px', width: '60px' }}
        />
      </div>
      <div>
        Show Debug Throw Line:
        <input
          type="checkbox"
          checked={showDebugLineTrait?.value ?? false}
          onChange={(e) => {
            if (watchEntity) {
              watchEntity.set(ShowDebugLine, { value: e.target.checked });
            }
          }}
          style={{ marginLeft: '10px' }}
        />
      </div>
      <div>
        Throw Strength:
        <input
          type="number"
          value={configurableThrowStrengthTrait?.value ?? 500}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && watchEntity) {
              watchEntity.set(ConfigurableThrowStrength, { value: val });
            }
          }}
          min="50"
          max="2000"
          step="50"
          style={{ marginLeft: '10px', width: '70px' }}
        />
      </div>
      <div>
        Flick Sensitivity (0=SDK Tap, 1=Max Prob. Flick):
        <input
          type="range" // Slider for sensitivity
          value={flickSensitivityTrait?.value ?? 0.0}
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && watchEntity) {
              watchEntity.set(FlickSensitivity, { value: val });
            }
          }}
          min="0.0"
          max="1" // Max 1.0 allows threshold to be 0.0 (triggers on any tap probability)
          step="0.05"
          style={{ marginLeft: '10px', width: '150px', verticalAlign: 'middle' }}
        />
        <span style={{ marginLeft: '10px' }}>{(flickSensitivityTrait?.value ?? 0.0).toFixed(2)}</span>
      </div>
      <div>
        Lookahead Delay (ms):
        <input
          type="number"
          value={configurableLookaheadDelayMsTrait?.value ?? 30}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && watchEntity) {
              watchEntity.set(ConfigurableLookaheadDelayMs, { value: Math.max(0, val) }); // Ensure non-negative
            }
          }}
          min="0" // Min 0 for no lookahead
          max="100" // Sensible max, can be adjusted
          step="5"
          style={{ marginLeft: '10px', width: '60px' }}
        />
      </div>
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
      ArmDirectionHistory,
      ConfigurableThrowWindowMs, 
      ShowDebugLine,             
      ConfigurableThrowStrength, // Add new trait for config
      FlickSensitivity,          // Add new trait for config
      ConfigurableLookaheadDelayMs, // Add new trait for config
      IsThrowPending             // Add new trait for managing lookahead state
    );
  }, [worldInstance]);


  useEffect(() => {
    // Initialize mouse position if it's the first run and entity is newly spawned
    if (watchEntity && watchEntity.get(MousePosition)?.x === 0 && watchEntity.get(MousePosition)?.y === 0) {
        watchEntity.set(MousePosition, { x: globalThis.innerWidth / 2, y: globalThis.innerHeight / 2 });
    }
  }, [watchEntity]);


  // Ensure watchEntity is passed to components that need it
  if (!watchEntity) return <div>Loading watch entity...</div>;

  return (
    <>
      <WatchManager watchEntity={watchEntity} />
      <VirtualMouse entity={watchEntity} />
      <WatchInfoDisplay watchEntity={watchEntity} /> 
    </>
  );
}

export default function App() {
  return (
    <WorldProvider world={world}>
      <AppContent />
    </WorldProvider>
  );
}
