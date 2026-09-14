# GridCharge AI

GridCharge provides a customer EV reservation flow and a connected admin grid-control center. The FastAPI backend broadcasts the Digital Twin state over WebSockets, while confirmed reservations reserve a compatible port and lifecycle actions synchronize both views.

## Run

In two terminals at the project root:

```powershell
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --reload --port 8000
```

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`; API documentation is at `http://localhost:8000/docs`.
