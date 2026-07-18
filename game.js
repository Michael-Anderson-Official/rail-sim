/* =========================================================================
   Rail Sim — 桜上水〜上北沢（京王線 実データ）ブラウザ3D 第1スライス
   ・実際の線路カーブ（OSM）を3Dで敷設
   ・桜上水を2面4線（本線±通過線＋待避線の passing loop）で表現
   ・特急が本線を通過する間、各停が待避線で待つ「待避」を再現（今回は台本制御）
   ========================================================================= */
(function () {
  'use strict';

  // ---- シーンの基本 ----
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbcd4e6);
  scene.fog = new THREE.Fog(0xbcd4e6, 600, 1400);

  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.getElementById('app').appendChild(renderer.domElement);

  var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 4000);
  camera.position.set(120, 180, 320);

  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;   // 地面より下に回り込まない
  controls.minDistance = 40;
  controls.maxDistance = 900;

  // ---- ライティング ----
  var hemi = new THREE.HemisphereLight(0xffffff, 0x788c78, 0.85);
  scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
  sun.position.set(-260, 380, 220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  var sc = sun.shadow.camera;
  sc.left = -600; sc.right = 600; sc.top = 400; sc.bottom = -400; sc.near = 1; sc.far = 1200;
  scene.add(sun);

  // ---- 地面（沿線の街をほのめかす低ポリ） ----
  var ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3000, 2000),
    new THREE.MeshLambertMaterial({ color: 0x9bb08a })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);
  scatterTown();

  // ---- 中心線（実カーブ）をスプライン化 ----
  // SEGMENT.points は [x(east), z(south)] のメートル。three.jsは (x, y, z)。
  var centerPts = SEGMENT.points.map(function (p) { return new THREE.Vector3(p[0], 0, p[1]); });
  var center = new THREE.CatmullRomCurve3(centerPts, false, 'catmullrom', 0.5);
  var stA = SEGMENT.stations.sakurajosui;   // 桜上水（東）
  var stB = SEGMENT.stations.kamikitazawa;  // 上北沢（西）
  var pSakura = new THREE.Vector3(stA[0], 0, stA[1]);

  // 中心線上で桜上水に一番近いパラメータ u を求める
  var uSakura = nearestU(center, pSakura);
  var LEN = center.getLength();
  var WINDOW = 150 / LEN;                    // 待避線が枝分かれする窓（±150m）

  // 待避線のふくらみ：窓の外は本線と同じ、中央で外へ +4m（passing loop）
  function loopBump(u) {
    var d = Math.abs(u - uSakura);
    if (d > WINDOW) return 0;
    var t = 1 - d / WINDOW;                  // 端0→中央1
    return smoothstep(t) * 4;                // 最大4mふくらむ
  }

  // 横オフセット付きの線路カーブを作る（法線方向へずらす）
  function offsetCurve(baseOffsetFn) {
    var N = 240, pts = [];
    for (var i = 0; i <= N; i++) {
      var u = i / N;
      var p = center.getPointAt(u);
      var tan = center.getTangentAt(u);
      var nx = -tan.z, nz = tan.x;           // xz平面での法線
      var off = baseOffsetFn(u);
      pts.push(new THREE.Vector3(p.x + nx * off, 0, p.z + nz * off));
    }
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  }

  // 4本の線路：本線±2m、待避線は本線から外へふくらむ
  var GAUGE = 1.6;
  var trackUpThrough = offsetCurve(function () { return 2; });    // 上り本線
  var trackDnThrough = offsetCurve(function () { return -2; });   // 下り本線（通過）
  var trackUpLoop = offsetCurve(function (u) { return 2 + loopBump(u); });   // 上り待避
  var trackDnLoop = offsetCurve(function (u) { return -2 - loopBump(u); });  // 下り待避

  [trackUpThrough, trackDnThrough, trackUpLoop, trackDnLoop].forEach(function (c) { buildTrack(c); });

  // ---- 桜上水の駅（2面4線：島式ホーム2面） ----
  buildStation();
  addLabel('桜上水', pSakura, 0x1b3a5b);
  addLabel('上北沢', new THREE.Vector3(stB[0], 0, stB[1]), 0x1b3a5b);

  // ---- 列車 ----
  // 下り（東→西）：特急は本線を通過、各停は待避線で待つ
  var express = makeTrain(4, 0xe4007f);   // 京王ピンク・特急・4両
  var local = makeTrain(3, 0xd7dbe0);     // 各停・3両
  scene.add(express.group); scene.add(local.group);

  // ---- 待避のタイムライン（台本制御。本格信号は次スライスで） ----
  // 各停は uStop で停車、特急が通過してから発車する
  var uStopLoop = uSakura;                 // 各停が待避で停まる位置（中心線パラメータ基準）
  var loopLen = trackDnLoop.getLength();
  var thrLen = trackDnThrough.getLength();
  var caption = document.getElementById('caption');

  var T = 0, CYCLE = 26;
  function updateTrains(dt) {
    T = (T + dt) % CYCLE;

    // --- 各停（下り待避線）---
    // 0-8s: 進入して減速→停車、8-18s: 待避で停車、18-26s: 発車して西へ
    var locU, locStopped = false;
    if (T < 8) {
      locU = ease(T / 8) * uStopLoop;                 // 進入して停車位置へ
    } else if (T < 18) {
      locU = uStopLoop; locStopped = true;            // 待避中
    } else {
      locU = uStopLoop + ease((T - 18) / 8) * (1 - uStopLoop); // 発車して終端へ
    }
    placeTrain(local, trackDnLoop, locU);

    // --- 特急（下り本線）：各停が待避に入った頃に通過 ---
    var exU;
    if (T < 6) { express.group.visible = false; exU = 0; }
    else { express.group.visible = true; exU = ease((T - 6) / 14); }  // 6-20sで一気に通過
    if (exU > 1) exU = 1;
    placeTrain(express, trackDnThrough, exU);

    // 実況キャプション
    if (T < 8) caption.textContent = '各停、桜上水の待避線に進入…';
    else if (T < 14) caption.textContent = '各停は待避線で停車。特急が本線を通過します';
    else if (T < 18) caption.textContent = '特急、通過。';
    else caption.textContent = '各停、発車。上北沢へ。';
  }

  // ---- メインループ ----
  var last = performance.now();
  function animate(now) {
    var dt = Math.min((now - last) / 1000, 0.05); last = now;
    updateTrains(dt);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  controls.target.copy(pSakura);
  requestAnimationFrame(animate);

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ====================== 部品づくり ======================

  // 線路：バラスト（帯）＋2本のレール＋枕木（インスタンス）
  function buildTrack(curve) {
    var N = 200;
    var pts = curve.getSpacedPoints(N);
    // バラスト帯
    var ballastGeo = ribbonGeometry(curve, N, 1.9, 0.02);
    var ballast = new THREE.Mesh(ballastGeo, new THREE.MeshLambertMaterial({ color: 0x8a8378 }));
    ballast.receiveShadow = true; scene.add(ballast);
    // レール2本
    [GAUGE / 2, -GAUGE / 2].forEach(function (off) {
      var railPts = [];
      for (var i = 0; i <= N; i++) {
        var u = i / N, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        railPts.push(new THREE.Vector3(p.x + nx * off, 0.15, p.z + nz * off));
      }
      var railCurve = new THREE.CatmullRomCurve3(railPts);
      var rail = new THREE.Mesh(
        new THREE.TubeGeometry(railCurve, N, 0.08, 6, false),
        new THREE.MeshStandardMaterial({ color: 0x5a5f66, metalness: 0.8, roughness: 0.4 })
      );
      rail.castShadow = true; scene.add(rail);
    });
    // 枕木（InstancedMesh）
    var step = 3, count = Math.floor(curve.getLength() / step);
    var tie = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.5, 0.12, 0.28),
      new THREE.MeshLambertMaterial({ color: 0x6b5842 }), count);
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (var i = 0; i < count; i++) {
      var u = i / count, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      var ang = Math.atan2(tan.x, tan.z);
      q.setFromAxisAngle(up, ang);
      m.compose(new THREE.Vector3(p.x, 0.06, p.z), q, new THREE.Vector3(1, 1, 1));
      tie.setMatrixAt(i, m);
    }
    tie.receiveShadow = true; scene.add(tie);
  }

  // 中心カーブに沿った平らな帯（バラスト用）
  function ribbonGeometry(curve, N, halfW, y) {
    var pos = [], idx = [];
    for (var i = 0; i <= N; i++) {
      var u = i / N, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      var nx = -tan.z, nz = tan.x;
      pos.push(p.x + nx * halfW, y, p.z + nz * halfW);
      pos.push(p.x - nx * halfW, y, p.z - nz * halfW);
    }
    for (var i = 0; i < N; i++) {
      var a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  // 桜上水の駅：2面の島式ホーム＋上屋
  function buildStation() {
    var pmat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4 });
    var roofmat = new THREE.MeshLambertMaterial({ color: 0x3a4a5a });
    [4, -4].forEach(function (side) {                  // 中心線から±4mに島式ホーム
      var half = 90, plat = new THREE.Group();
      var slabPts = [];
      for (var i = 0; i <= 40; i++) {
        var u = uSakura - WINDOW * 0.9 + (WINDOW * 1.8) * (i / 40);
        if (u < 0 || u > 1) continue;
        var p = center.getPointAt(u), tan = center.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        slabPts.push(new THREE.Vector3(p.x + nx * side, 0, p.z + nz * side));
      }
      if (slabPts.length < 2) return;
      var slabCurve = new THREE.CatmullRomCurve3(slabPts);
      var slab = new THREE.Mesh(ribbonRaised(slabCurve, slabPts.length * 3, 2.2, 0.9),
        pmat);
      slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
      // 上屋（薄い屋根）
      var roof = new THREE.Mesh(ribbonRaised(slabCurve, slabPts.length * 3, 2.6, 4.4), roofmat);
      scene.add(roof);
    });
  }

  // 高さのある帯（ホーム床/屋根）: 上面のみの板を y に置く
  function ribbonRaised(curve, N, halfW, y) {
    return (function () {
      var g = ribbonGeometry(curve, N, halfW, y);
      return g;
    })();
  }

  // 列車：先頭〜後尾の箱をつなぐ
  function makeTrain(cars, color) {
    var group = new THREE.Group();
    var body = new THREE.MeshStandardMaterial({ color: color, metalness: 0.2, roughness: 0.6 });
    var win = new THREE.MeshStandardMaterial({ color: 0x1b2733, metalness: 0.5, roughness: 0.3 });
    var CAR = 18, GAP = 2;
    var carGeo = new THREE.BoxGeometry(CAR, 3.4, 2.8);
    var winGeo = new THREE.BoxGeometry(CAR * 0.92, 1.1, 2.9);
    var arr = [];
    for (var i = 0; i < cars; i++) {
      var c = new THREE.Group();
      var b = new THREE.Mesh(carGeo, body); b.position.y = 2.0; b.castShadow = true; c.add(b);
      var w = new THREE.Mesh(winGeo, win); w.position.y = 2.5; c.add(w);
      c.userData.spacing = i * (CAR + GAP);
      group.add(c); arr.push(c);
    }
    return { group: group, cars: arr, carLen: CAR + GAP, total: cars * (CAR + GAP) };
  }

  // 列車をカーブ上の位置 u（先頭）に配置。各車を後ろへ並べて向きも合わせる
  function placeTrain(train, curve, uHead) {
    var L = curve.getLength();
    train.cars.forEach(function (c) {
      var dist = uHead * L - c.userData.spacing - 9;   // 車体中心
      var u = Math.max(0, Math.min(1, dist / L));
      var p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      c.position.set(p.x, 0, p.z);
      c.rotation.y = Math.atan2(tan.x, tan.z);
    });
  }

  // 駅名ラベル（キャンバス→スプライト。常にカメラを向く）
  function addLabel(text, pos, color) {
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; roundRect(ctx, 6, 20, 244, 56, 14); ctx.fill();
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 44px "Hiragino Kaku Gothic ProN", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 50);
    var tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.position.set(pos.x, 22, pos.z); sp.scale.set(34, 12.75, 1);
    scene.add(sp);
  }

  // 沿線の街（低ポリのビルをまばらに）
  function scatterTown() {
    var mats = [0xcfc6b6, 0xbfb2a0, 0xd8d8d8, 0xc8b8a0].map(function (c) {
      return new THREE.MeshLambertMaterial({ color: c });
    });
    for (var i = 0; i < 140; i++) {
      var x = (Math.random() - 0.5) * 2200, z = (Math.random() - 0.5) * 1200;
      if (Math.abs(z) < 40) continue;                 // 線路の帯は空ける
      var w = 8 + Math.random() * 16, h = 6 + Math.random() * 40, d = 8 + Math.random() * 16;
      var b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[i % mats.length]);
      b.position.set(x, h / 2, z); b.castShadow = true; b.receiveShadow = true;
      scene.add(b);
    }
  }

  // ====================== ヘルパー ======================
  function smoothstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  function ease(t) { t = Math.max(0, Math.min(1, t)); return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function nearestU(curve, target) {
    var best = 0, bd = Infinity;
    for (var i = 0; i <= 400; i++) {
      var u = i / 400, p = curve.getPointAt(u), d = p.distanceToSquared(target);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
})();
