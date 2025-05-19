import './App.css';
import { useEffect, useRef, useMemo, useState } from 'react';
import { Watch } from 'touch-sdk';
import { trait, createWorld, Entity } from 'koota'; 
import { useTrait, WorldProvider, useWorld } from 'koota/react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrthographicCamera, Line as DreiLine } from '@react-three/drei'
import * as THREE from 'three';

interface Vector3 { x: number; y: number; z: number; }
interface Vector4 extends Vector3 { w: number; }
interface Vector2 { x: number; y: number; }
interface TouchScreenResolution { width: number; height: number; }
interface GestureProbDetail { [key: string]: number; }

const ARM_DIRECTION_HISTORY_MAX_AGE_MS = 200;
const MIN_THROW_SPEED_THRESHOLD = 5.0;
const DEBUG_LINE_VISUAL_SCALE = 0.1;
const TAP_ACTION_DEBOUNCE_MS = 100;

const ANGULAR_FRICTION_CONSTANT = 0.8;
const MIN_CONTINUING_ANGULAR_VELOCITY = 0.02;
const MIN_SEGMENTS_FOR_ENDING_CURVE = 2;

const FRICTION_FACTOR_HIGH_SPEED = 1.4;
const FRICTION_FACTOR_LOW_SPEED = 6.0;
const FRICTION_TRANSITION_MAX_SPEED = 300.0;

const FLICK_SENSITIVITY_EXPONENT = 3.0;
const FLICK_SENSITIVITY_UI_QUADRATIC_A = -1.8;
const FLICK_SENSITIVITY_UI_QUADRATIC_B = 2.8;
const BOUNDARY_PADDING = 50;

const ConfigurableThrowWindowMs = trait({ value: 50 }); 
const ShowDebugLine = trait({ value: false }); 
const ConfigurableThrowStrength = trait({ value: 900 });
const FlickSensitivity = trait({ value: 0.0 });
const ConfigurableLookaheadDelayMs = trait({ value: 30 });
const IsThrowPending = trait({ value: false });
const EnableCurveball = trait({ value: false });
const ThrowPathPlan = trait({
  segments: [] as { dx: number; dy: number; duration: number }[],
  currentIndex: 0,
  activeTimeInSegment: 0,
  endingAngularVelocity: 0.0,
});

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
const MouseAngularVelocityCurve = trait({ value: 0.0 });
const MouseContinuingAngularVelocity = trait({ value: 0.0 });

export const world = createWorld();

let lastTapActionTimestamp = 0;

const executeActualThrowLogic = (watchEntity: Entity, tapTimestamp: number) => {
  console.log(`[executeActualThrowLogic] Called. TapTimestamp: ${tapTimestamp}`);

  if (watchEntity.get(IsThrown)?.value === true) {
      console.log('[executeActualThrowLogic] Mouse is already marked as thrown (e.g., caught during lookahead). Aborting this throw attempt.');
      return;
  }

  const currentThrowStrength = watchEntity.get(ConfigurableThrowStrength)?.value ?? 900;
  const configurableThrowWindowMs = watchEntity.get(ConfigurableThrowWindowMs)?.value ?? 50;
  const lookaheadDelayMs = watchEntity.get(ConfigurableLookaheadDelayMs)?.value ?? 0; 
  const history = watchEntity.get(ArmDirectionHistory);
  const enableCurveball = watchEntity.get(EnableCurveball)?.value ?? false;

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
  } else {
    const armDir = watchEntity.get(ArmDirection)?.value;
    if (armDir && typeof armDir.x === 'number' && typeof armDir.y === 'number') {
      throwDx = armDir.x;
      throwDy = armDir.y;
    } else {
      console.log('[executeActualThrowLogic] No valid arm direction data for base throw. Cannot throw.');
      watchEntity.set(IsThrown, { value: false });
      return; 
    }
  }

  if (enableCurveball && recentSamples.length > 0) {
    const sortedSamples = [...recentSamples].sort((a, b) => a.timestamp - b.timestamp);
    const pathSegments: { dx: number; dy: number; duration: number }[] = [];
    let calculatedEndingAngularVelocity = 0.0;

    for (let i = 0; i < sortedSamples.length; i++) {
      const currentSample = sortedSamples[i];
      const mag = Math.sqrt(currentSample.dx * currentSample.dx + currentSample.dy * currentSample.dy);
      if (mag > 0.001) { 
        const normDx = currentSample.dx / mag;
        const normDy = currentSample.dy / mag;

        let duration = 0.05;
        if (i < sortedSamples.length - 1) {
          const nextSample = sortedSamples[i+1];
          const timeDiffMs = nextSample.timestamp - currentSample.timestamp;
          duration = Math.max(0.02, timeDiffMs / 1000.0);
        } else {
          duration = 0.2;
        }
        pathSegments.push({ dx: normDx, dy: normDy, duration });
      }
    }

    if (pathSegments.length > 0) {
      if (pathSegments.length >= MIN_SEGMENTS_FOR_ENDING_CURVE) {
        let weightedSumAngularVelocity = 0;
        let sumOfWeights = 0;
        let numAngleDiffsCalculated = 0;

        for (let i = 0; i < pathSegments.length - 1; i++) {
            const seg1 = pathSegments[i];
            const seg2 = pathSegments[i+1];
            
            const angle1 = Math.atan2(seg1.dy, seg1.dx);
            const angle2 = Math.atan2(seg2.dy, seg2.dx);
            let angleDiff = angle2 - angle1;
            while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
            while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

            const relevantDuration = seg2.duration > 0.001 ? seg2.duration : 0.02; 
            const currentAngularVelocity = angleDiff / relevantDuration;
            
            const weight = i + 1; 

            weightedSumAngularVelocity += currentAngularVelocity * weight;
            sumOfWeights += weight;
            numAngleDiffsCalculated++;
        }

        if (numAngleDiffsCalculated > 0 && sumOfWeights > 0) {
            calculatedEndingAngularVelocity = weightedSumAngularVelocity / sumOfWeights;
            console.log(`[executeActualThrowLogic] Weighted Avg EndingAngVel: sumWeightedVel=${weightedSumAngularVelocity.toFixed(3)}, sumWeights=${sumOfWeights.toFixed(3)}, num=${numAngleDiffsCalculated}, result=${calculatedEndingAngularVelocity.toFixed(3)}`);
        } else {
            calculatedEndingAngularVelocity = 0.0;
            console.log(`[executeActualThrowLogic] Weighted Avg EndingAngVel: Not enough data or zero weights. Result: 0.0`);
        }
      } else {
        calculatedEndingAngularVelocity = 0.0;
        console.log(`[executeActualThrowLogic] EndingAngVel: Not enough segments (${pathSegments.length}). Result: 0.0`);
      }

      watchEntity.set(ThrowPathPlan, { 
        segments: pathSegments, 
        currentIndex: 0, 
        activeTimeInSegment: 0, 
        endingAngularVelocity: calculatedEndingAngularVelocity 
      });
      watchEntity.set(MouseContinuingAngularVelocity, { value: calculatedEndingAngularVelocity });
      console.log(`[executeActualThrowLogic] Set MouseContinuingAngularVelocity to: ${calculatedEndingAngularVelocity.toFixed(4)}`);

      throwDx = pathSegments[0].dx;
      throwDy = pathSegments[0].dy;
      console.log(`[executeActualThrowLogic] Curveball Path Plan created with ${pathSegments.length} segments. Initial direction: dx=${throwDx.toFixed(2)}, dy=${throwDy.toFixed(2)}`);
    } else {
      watchEntity.set(ThrowPathPlan, { segments: [], currentIndex: 0, activeTimeInSegment: 0, endingAngularVelocity: 0.0 });
      watchEntity.set(MouseContinuingAngularVelocity, { value: 0.0 });
      console.log('[executeActualThrowLogic] Curveball enabled, but Path Plan failed (e.g. no movement in samples). Using base straight direction.');
    }
    watchEntity.set(MouseAngularVelocityCurve, { value: 0.0 });

  } else {
    watchEntity.set(ThrowPathPlan, { segments: [], currentIndex: 0, activeTimeInSegment: 0, endingAngularVelocity: 0.0 });
    watchEntity.set(MouseAngularVelocityCurve, { value: 0.0 });
    watchEntity.set(MouseContinuingAngularVelocity, { value: 0.0 });
  }

  const finalVelX = throwDx * currentThrowStrength;
  const finalVelY = throwDy * currentThrowStrength;

  watchEntity.set(MouseVelocity, { x: finalVelX, y: finalVelY });
  watchEntity.set(IsThrown, { value: true });
  console.log(`[executeActualThrowLogic] Mouse Thrown! Velocity: x:${finalVelX.toFixed(2)}, y:${finalVelY.toFixed(2)}`);
};

function performThrowOrCatchAction(watchEntity: Entity) {
  const now = Date.now();
  if (now - lastTapActionTimestamp < TAP_ACTION_DEBOUNCE_MS) {
    console.log('[performThrowOrCatchAction] Debounced due to rapid action.');
    return; 
  }
  lastTapActionTimestamp = now;
  watchEntity.set(LastTapTime, { value: new Date(now) });

  if (watchEntity.get(IsThrowPending)?.value) {
    console.log('[performThrowOrCatchAction] Action ignored, throw already pending from lookahead.');
    return;
  }

  const isCurrentlyThrown = watchEntity.get(IsThrown)?.value ?? false;
  console.log(`[performThrowOrCatchAction] Action initiated. IsCurrentlyThrown: ${isCurrentlyThrown}`);

  if (isCurrentlyThrown) {
    watchEntity.set(IsThrown, { value: false });
    watchEntity.set(MouseVelocity, { x: 0, y: 0 });
    console.log('[performThrowOrCatchAction] Mouse Caught (was thrown).');
    if (watchEntity.get(IsThrowPending)?.value) {
        console.log('[performThrowOrCatchAction] Catch occurred while a throw was pending; clearing pending state.');
        watchEntity.set(IsThrowPending, { value: false });
    }
  } else {
    const tapTimestamp = Date.now();
    const lookaheadDelayMs = watchEntity.get(ConfigurableLookaheadDelayMs)?.value ?? 0;
    
    console.log(`[performThrowOrCatchAction] Attempting throw. TapTime: ${tapTimestamp}, LookaheadDelayMs: ${lookaheadDelayMs}`);

    if (lookaheadDelayMs > 0) {
      watchEntity.set(IsThrowPending, { value: true });
      console.log(`[performThrowOrCatchAction] Scheduling throw logic after ${lookaheadDelayMs}ms for lookahead.`);
      setTimeout(() => {
        console.log('[performThrowOrCatchAction] setTimeout: Executing delayed throw logic.');
        if (watchEntity.get(IsThrowPending)?.value) {
            executeActualThrowLogic(watchEntity, tapTimestamp);
        }
        watchEntity.set(IsThrowPending, { value: false });
        console.log('[performThrowOrCatchAction] setTimeout: Lookahead processing complete, IsThrowPending set to false.');
      }, lookaheadDelayMs);
    } else {
      console.log('[performThrowOrCatchAction] Executing throw logic immediately (no lookahead).');
      executeActualThrowLogic(watchEntity, tapTimestamp);
    }
  }
}

function WatchManager({ watchEntity }: { watchEntity: Entity }) {
  const sdkWatchRef = useRef<Watch | null>(null);
  const connectButtonContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const watch = new Watch();
    sdkWatchRef.current = watch;
    if (connectButtonContainerRef.current) {
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
      if (sdkWatchRef.current) {
        watchEntity.set(Hand, { value: sdkWatchRef.current.hand });
        watchEntity.set(HapticsAvailable, { value: sdkWatchRef.current.hapticsAvailable });
        watchEntity.set(TouchScreenRes, { value: sdkWatchRef.current.touchScreenResolution });
        watchEntity.set(BatteryPercentage, { value: sdkWatchRef.current.batteryPercentage });
      }
    };
    const handleDisconnected = () => watchEntity.set(IsConnected, { value: false });

    const tapListener = () => {
      console.log('[WatchManager] SDK tap event received.');
      performThrowOrCatchAction(watchEntity);
    };

    const probabilityListener = (event: CustomEvent<GestureProbDetail>) => {
      const gestureProb = event.detail;
      watchEntity.set(GestureProb, { value: gestureProb });

      const currentFlickSensitivityUI = watchEntity.get(FlickSensitivity)?.value ?? 0;
      if (currentFlickSensitivityUI > 0) {
        const tapProbability = gestureProb?.tap ?? 0;
        
        const flickSensitivityInternal = (FLICK_SENSITIVITY_UI_QUADRATIC_A * Math.pow(currentFlickSensitivityUI, 2)) + (FLICK_SENSITIVITY_UI_QUADRATIC_B * currentFlickSensitivityUI);
        const clampedFlickSensitivityInternal = Math.max(0, Math.min(1, flickSensitivityInternal));

        const probabilityThreshold = Math.pow(1.0 - clampedFlickSensitivityInternal, FLICK_SENSITIVITY_EXPONENT);
        
        if (tapProbability >= probabilityThreshold) { 
          console.log(`[WatchManager] Flick-tap detected! Prob: ${tapProbability.toFixed(3)} >= Thresh: ${probabilityThreshold.toFixed(5)} (UI Sens: ${currentFlickSensitivityUI.toFixed(2)}, Internal Sens: ${clampedFlickSensitivityInternal.toFixed(2)}, Exp: ${FLICK_SENSITIVITY_EXPONENT})`);
          performThrowOrCatchAction(watchEntity);
        }
      }
    };

    const armDirectionListener = (event: CustomEvent<{ dx: number; dy: number }>) => { 
      const eventData = event.detail;
      if (eventData && typeof eventData.dx === 'number' && typeof eventData.dy === 'number') {
        watchEntity.set(ArmDirection, { value: { x: eventData.dx, y: eventData.dy } });

        const historyTrait = watchEntity.get(ArmDirectionHistory);
        let currentSamples = historyTrait?.samples ? [...historyTrait.samples] : [];

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
  }, [watchEntity]);


  return (
    <>
      <div ref={connectButtonContainerRef} style={{ marginBottom: '20px' }}></div>
    </>
  );
}

function R3FMouseCursor({ entity }: { entity: Entity }) {
  const meshRef = useRef<THREE.Mesh>(null!); 
  const isThrownStateHook = useTrait(entity, IsThrown);
  const isCurrentlyThrownForColor = isThrownStateHook ? isThrownStateHook.value : false;
  const enableCurveball = useTrait(entity, EnableCurveball)?.value ?? false;

  useFrame((_, delta) => {
    if (!meshRef.current || !entity) {
      return;
    }

    const kootaPosition = entity.get(MousePosition);
    const kootaVelocity = entity.get(MouseVelocity);
    const isThrownState = entity.get(IsThrown);
    const pathPlanTrait = entity.get(ThrowPathPlan);
    const continuingAngularVelocityState = entity.get(MouseContinuingAngularVelocity);
    const currentContinuingAngularVelocity = continuingAngularVelocityState?.value ?? 0.0;

    if (!kootaPosition || !kootaVelocity || !isThrownState) {
      return;
    }

    let newKootaX = kootaPosition.x;
    let newKootaY = kootaPosition.y;
    let newKootaVelX = kootaVelocity.x;
    let newKootaVelY = kootaVelocity.y;

    if (isThrownState.value) {
      newKootaX += newKootaVelX * delta;
      newKootaY += newKootaVelY * delta;

      const currentSpeed = Math.sqrt(newKootaVelX**2 + newKootaVelY**2);

      if (enableCurveball && pathPlanTrait && pathPlanTrait.segments.length > 0 && pathPlanTrait.currentIndex < pathPlanTrait.segments.length) {
        const plan = pathPlanTrait;
        const segment = plan.segments[plan.currentIndex];

        if (currentSpeed > 0.01) { 
            newKootaVelX = segment.dx * currentSpeed;
            newKootaVelY = segment.dy * currentSpeed;
        }

        plan.activeTimeInSegment += delta;
        if (plan.activeTimeInSegment >= segment.duration) {
          if (plan.currentIndex < plan.segments.length - 1) {
            plan.currentIndex++;
            plan.activeTimeInSegment = 0;
          } else {
            plan.currentIndex++;
            plan.activeTimeInSegment = 0;
            console.log(`[R3FMouseCursor] Path plan COMPLETED. currentIndex set to ${plan.currentIndex}`);
          }
        }
        entity.set(ThrowPathPlan, { 
            segments: plan.segments, 
            currentIndex: plan.currentIndex, 
            activeTimeInSegment: plan.activeTimeInSegment,
            endingAngularVelocity: plan.endingAngularVelocity
        });
      }

      const isPathPlanActive = enableCurveball && pathPlanTrait && pathPlanTrait.segments.length > 0 && pathPlanTrait.currentIndex < pathPlanTrait.segments.length;

      if (enableCurveball && !isPathPlanActive && currentSpeed > MIN_THROW_SPEED_THRESHOLD) {
        if (currentContinuingAngularVelocity !== 0) {
          const angleDelta = currentContinuingAngularVelocity * delta;
          const cosA = Math.cos(angleDelta);
          const sinA = Math.sin(angleDelta);
          const newVelXRotated = newKootaVelX * cosA - newKootaVelY * sinA;
          const newVelYRotated = newKootaVelX * sinA + newKootaVelY * cosA;
          newKootaVelX = newVelXRotated;
          newKootaVelY = newVelYRotated;

          let nextContinuingAngularVelocity = currentContinuingAngularVelocity * (1 - ANGULAR_FRICTION_CONSTANT * delta);
          if (Math.abs(nextContinuingAngularVelocity) < MIN_CONTINUING_ANGULAR_VELOCITY) {
            nextContinuingAngularVelocity = 0.0;
          }
          entity.set(MouseContinuingAngularVelocity, { value: nextContinuingAngularVelocity });
        } else {
           console.log(`[R3FMouseCursor] Path plan ended or no plan, but ContinuingAngVel is zero. Speed: ${currentSpeed.toFixed(2)}`);
        }
      } 
      
      let dynamicFrictionFactor;
      if (currentSpeed <= MIN_THROW_SPEED_THRESHOLD) {
        dynamicFrictionFactor = FRICTION_FACTOR_LOW_SPEED;
      } else if (currentSpeed >= FRICTION_TRANSITION_MAX_SPEED) {
        dynamicFrictionFactor = FRICTION_FACTOR_HIGH_SPEED;
      } else {
        const speedRatio = (currentSpeed - MIN_THROW_SPEED_THRESHOLD) / (FRICTION_TRANSITION_MAX_SPEED - MIN_THROW_SPEED_THRESHOLD);
        dynamicFrictionFactor = FRICTION_FACTOR_LOW_SPEED + (FRICTION_FACTOR_HIGH_SPEED - FRICTION_FACTOR_LOW_SPEED) * speedRatio;
      }
      
      newKootaVelX *= (1 - dynamicFrictionFactor * delta); 
      newKootaVelY *= (1 - dynamicFrictionFactor * delta);

      const speedAfterFriction = Math.sqrt(newKootaVelX**2 + newKootaVelY**2);
      if (speedAfterFriction < MIN_THROW_SPEED_THRESHOLD) {
        entity.set(IsThrown, { value: false });
        newKootaVelX = 0;
        newKootaVelY = 0;
      }

      if (newKootaX < BOUNDARY_PADDING) { 
        newKootaX = BOUNDARY_PADDING; 
        newKootaVelX = 0; 
      }
      if (newKootaX > globalThis.innerWidth - BOUNDARY_PADDING) { 
        newKootaX = globalThis.innerWidth - BOUNDARY_PADDING; 
        newKootaVelX = 0; 
      }
      if (newKootaY < BOUNDARY_PADDING) { 
        newKootaY = BOUNDARY_PADDING; 
        newKootaVelY = 0; 
      }
      if (newKootaY > globalThis.innerHeight - BOUNDARY_PADDING) { 
        newKootaY = globalThis.innerHeight - BOUNDARY_PADDING; 
        newKootaVelY = 0; 
      }

      entity.set(MousePosition, { x: newKootaX, y: newKootaY });
      entity.set(MouseVelocity, { x: newKootaVelX, y: newKootaVelY });
    }
    meshRef.current.position.x = newKootaX - globalThis.innerWidth / 2;
    meshRef.current.position.y = -(newKootaY - globalThis.innerHeight / 2);
  });

  const initialKootaPos = entity.get(MousePosition);
  const initialMeshX = initialKootaPos ? initialKootaPos.x - globalThis.innerWidth / 2 : 0;
  const initialMeshY = initialKootaPos ? -(initialKootaPos.y - globalThis.innerHeight / 2) : 0;

  return (
    <mesh ref={meshRef} position={[initialMeshX, initialMeshY, 0]}>
      <circleGeometry args={[10, 32]} /> 
      <meshBasicMaterial color={isCurrentlyThrownForColor ? "red" : "blue"} />
    </mesh>
  );
}

function DebugThrowVectorLine({ watchEntity }: { watchEntity: Entity }) {
  const isThrownState = useTrait(watchEntity, IsThrown);
  const isCurrentlyThrown = isThrownState ? isThrownState.value : false;
  
  const configurableThrowWindow = useTrait(watchEntity, ConfigurableThrowWindowMs)?.value ?? 50;
  const showDebugLineSetting = useTrait(watchEntity, ShowDebugLine)?.value ?? false;
  const currentThrowStrength = useTrait(watchEntity, ConfigurableThrowStrength)?.value ?? 900;

  const [linePoints, setLinePoints] = useState<THREE.Vector3[]>([
    new THREE.Vector3(0,0,0.1),
    new THREE.Vector3(0,0,0.1)
  ]);

  useFrame(() => {
    if (!watchEntity) {
      return;
    }
    if (!showDebugLineSetting || isCurrentlyThrown) {
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
    const lookaheadDelayMs = watchEntity.get(ConfigurableLookaheadDelayMs)?.value ?? 0;
    const tapTime = Date.now();

    const historyStartTime = tapTime - configurableThrowWindow;
    const historyEndTime = tapTime + lookaheadDelayMs;

    const samplesToUse = (historyTrait?.samples || []).filter(
      sample => sample.timestamp >= historyStartTime && sample.timestamp <= historyEndTime
    );
    
    samplesToUse.sort((a, b) => a.timestamp - b.timestamp);

    if (samplesToUse.length > 0) {
      let currentX = startX_r3f;
      let currentY = startY_r3f;
      const numSamples = samplesToUse.length;
      const perSampleScale = DEBUG_LINE_VISUAL_SCALE / (numSamples > 1 ? Math.sqrt(numSamples) : 1);

      for (const sample of samplesToUse) {
        const dx = sample.dx;
        const dy = sample.dy;

        const vecX_r3f_segment = dx * currentThrowStrength * perSampleScale; 
        const vecY_r3f_segment = -(dy * currentThrowStrength * perSampleScale);
        
        currentX += vecX_r3f_segment;
        currentY += vecY_r3f_segment;
        points.push(new THREE.Vector3(currentX, currentY, 0.1));
      }
      if (points.length === 1) {
          const currentArmDir = watchEntity.get(ArmDirection);
          if (currentArmDir?.value) {
            const vecX_r3f = currentArmDir.value.x * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE;
            const vecY_r3f = -(currentArmDir.value.y * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE);
            points.push(new THREE.Vector3(startX_r3f + vecX_r3f, startY_r3f + vecY_r3f, 0.1));
          } else {
            points.push(new THREE.Vector3(startX_r3f, startY_r3f, 0.1));
          }
      }
    } else {
      const currentArmDir = watchEntity.get(ArmDirection);
      let potentialDx = 0;
      let potentialDy = 0;
      if (currentArmDir?.value) {
        potentialDx = currentArmDir.value.x;
        potentialDy = currentArmDir.value.y;
      }
      const vecX_r3f = potentialDx * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE;
      const vecY_r3f = -(potentialDy * currentThrowStrength * DEBUG_LINE_VISUAL_SCALE);
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

      if (entity) {
        const isThrownState = entity.get(IsThrown);
        if (isThrownState && !isThrownState.value) { 
          entity.set(MousePosition, { x: newWidth / 2, y: newHeight / 2 });
        }
      }
    };
    globalThis.addEventListener('resize', handleResize);
    return () => globalThis.removeEventListener('resize', handleResize);
  }, [entity]);
  

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
        left={-screenSize.width / 2}
        right={screenSize.width / 2}
        top={screenSize.height / 2}
        bottom={-screenSize.height / 2}
        near={1}
        far={1000} 
        position={[0, 0, 10]} 
      />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />

      entity && <R3FMouseCursor entity={entity} />
      entity && <DebugThrowVectorLine watchEntity={entity} />


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

  const configurableThrowWindowMsTrait = useTrait(watchEntity, ConfigurableThrowWindowMs);
  const showDebugLineTrait = useTrait(watchEntity, ShowDebugLine);
  const configurableThrowStrengthTrait = useTrait(watchEntity, ConfigurableThrowStrength);
  const flickSensitivityTrait = useTrait(watchEntity, FlickSensitivity);
  const configurableLookaheadDelayMsTrait = useTrait(watchEntity, ConfigurableLookaheadDelayMs);
  const enableCurveballTrait = useTrait(watchEntity, EnableCurveball);

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
          value={configurableThrowStrengthTrait?.value ?? 900}
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
          type="range"
          value={flickSensitivityTrait?.value ?? 0.0}
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && watchEntity) {
              watchEntity.set(FlickSensitivity, { value: val });
            }
          }}
          min="0.0"
          max="1"
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
              watchEntity.set(ConfigurableLookaheadDelayMs, { value: Math.max(0, val) });
            }
          }}
          min="0"
          max="100"
          step="5"
          style={{ marginLeft: '10px', width: '60px' }}
        />
      </div>
      <div>
        Enable Curveball Throw:
        <input
          type="checkbox"
          checked={enableCurveballTrait?.value ?? false}
          onChange={(e) => {
            if (watchEntity) {
              watchEntity.set(EnableCurveball, { value: e.target.checked });
            }
          }}
          style={{ marginLeft: '10px' }}
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
      ConfigurableThrowStrength,
      FlickSensitivity,
      ConfigurableLookaheadDelayMs,
      IsThrowPending,
      EnableCurveball,
      ThrowPathPlan,
      MouseAngularVelocityCurve,
      MouseContinuingAngularVelocity
    );
  }, [worldInstance]);


  useEffect(() => {
    if (watchEntity && watchEntity.get(MousePosition)?.x === 0 && watchEntity.get(MousePosition)?.y === 0) {
        watchEntity.set(MousePosition, { x: globalThis.innerWidth / 2, y: globalThis.innerHeight / 2 });
    }
  }, [watchEntity]);


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
