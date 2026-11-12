package constraints.generated.procedures;

import constraints.generated.AutoValueMappers;
import gov.nasa.ammos.plandev.contrib.serialization.rulesets.BasicValueMappers;
import gov.nasa.ammos.plandev.merlin.framework.ValueMapper;
import gov.nasa.ammos.plandev.merlin.protocol.model.InputType;
import gov.nasa.ammos.plandev.merlin.protocol.types.InstantiationException;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.merlin.protocol.types.UnconstructableArgumentException;
import gov.nasa.ammos.plandev.merlin.protocol.types.ValueSchema;
import gov.nasa.ammos.plandev.procedural.constraints.ProcedureMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class MinBatterySOC implements ProcedureMapper<constraints.procedures.MinBatterySOC> {
  @Override
  public ValueSchema valueSchema() {
    return AutoValueMappers.constraints_procedures_MinBatterySOC(
            BasicValueMappers.$double()).getValueSchema();
  }

  @Override
  public InputType<constraints.procedures.MinBatterySOC> getInputType() {
    return new InputMapper();
  }

  public final class InputMapper implements InputType<constraints.procedures.MinBatterySOC> {
    private final ValueMapper<Double> mapper_minSOC;

    @SuppressWarnings("unchecked")
    public InputMapper() {
      this.mapper_minSOC =
          BasicValueMappers.$double();
    }

    @Override
    public List<String> getRequiredParameters() {
      return List.of();
    }

    @Override
    public ArrayList<InputType.Parameter> getParameters() {
      final var parameters = new ArrayList<InputType.Parameter>();
      parameters.add(new InputType.Parameter("minSOC", this.mapper_minSOC.getValueSchema()));
      return parameters;
    }

    @Override
    public Map<String, SerializedValue> getArguments(
        final constraints.procedures.MinBatterySOC input) {
      final var arguments = new HashMap<String, SerializedValue>();
      arguments.put("minSOC", this.mapper_minSOC.serializeValue(input.minSOC()));
      return arguments;
    }

    @Override
    public constraints.procedures.MinBatterySOC instantiate(
        final Map<String, SerializedValue> arguments) throws InstantiationException {
      Optional<Double> minSOC = Optional.empty();

      final var instantiationExBuilder = new InstantiationException.Builder("MinBatterySOC");

      for (final var entry : arguments.entrySet()) {
        try {
          switch (entry.getKey()) {
            case "minSOC":
              minSOC = Optional.ofNullable(this.mapper_minSOC.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("minSOC", failure)));
              break;
            default:
              instantiationExBuilder.withExtraneousArgument(entry.getKey());
          }
        } catch (final UnconstructableArgumentException e) {
          instantiationExBuilder.withUnconstructableArgument(e.parameterName, e.failure);
        }
      }

      minSOC.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("minSOC", this.mapper_minSOC.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("minSOC", this.mapper_minSOC.getValueSchema()));

      instantiationExBuilder.throwIfAny();
      return new constraints.procedures.MinBatterySOC(minSOC.get());
    }

    @Override
    public List<InputType.ValidationNotice> getValidationFailures(
        final constraints.procedures.MinBatterySOC input) {
      final var notices = new ArrayList<InputType.ValidationNotice>();
      return notices;
    }
  }
}
